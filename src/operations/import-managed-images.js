import { parseChatJsonl } from '../chat-recovery.js';
import { roleplayHash, roleplayLease } from '../roleplay-store.js';
import { checkManagedImageDestination, decodeCompatibleImage, ensureManagedImageNamespace, publishManagedImage, verifyManagedImage } from '../managed-image-files.js';
import { operationError, withOperation } from './store.js';
import { uiText } from '../../public/scripts/ui-text.js';

export const MANAGED_IMAGE_MARKER = '.neconyan-managed-images.json';
export const MANAGED_IMAGE_PREFIX = 'user/images/neconyan-repaired';
export const managedImportPath = relative => relative === MANAGED_IMAGE_MARKER || relative === MANAGED_IMAGE_PREFIX || relative.startsWith(MANAGED_IMAGE_PREFIX + '/');
export function assertManagedImportSpelling(relative) {
    const canonical = relative.split('/').map(part => part.replace(/[. ]+$/, '').toLowerCase()).join('/');
    if (managedImportPath(canonical) && relative !== canonical) throw operationError(uiText('The backup contains a compatible-copy path that could be read two ways. Keep its original files, correct the path, then import again.'), 409);
}
const markerPath = MANAGED_IMAGE_PREFIX + '/' + MANAGED_IMAGE_MARKER;
const assetPattern = /^([a-f0-9]{64})\.(png|jpg|webp)$/;
const fail = () => operationError(uiText('The backup\'s compatible copies are incomplete or conflict with each other, so this import cannot continue. Use a complete backup.'), 409);
function envelope(bytes) {
    if (bytes.length > 4096) throw fail();
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); } catch { throw fail(); }
    if (!parsed?.value || typeof parsed.value !== 'object' || parsed.hash !== roleplayHash(parsed.value)) throw fail();
    return parsed.value;
}
function imageFrom(bytes, name) {
    const match = assetPattern.exec(name);
    if (!match || bytes.length > 1024 * 1024) throw fail();
    const mime = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' }[match[2]];
    const image = decodeCompatibleImage(`data:${mime};base64,${bytes.toString('base64')}`);
    if (image.rawHash !== match[1] || image.extension !== match[2]) throw fail();
    return image;
}
/** Validate the complete dependency bundle before any ordinary import publication or staging. */
export async function prepareManagedImageImport(context, plan, read) {
    for (const relative of [...plan.files.map(file => file.relative), ...plan.directories]) assertManagedImportSpelling(relative);
    const selected = plan.files.map((file, index) => ({ file, index })).filter(({ file }) => managedImportPath(file.relative));
    const map = new Map();
    if (!selected.length) return map;
    if (selected.length > 8194) throw fail();
    const byPath = new Map(selected.map(item => [item.file.relative, item]));
    if (byPath.size !== selected.length || !byPath.has(MANAGED_IMAGE_MARKER) || !byPath.has(markerPath)) throw fail();
    const readAt = async relative => { const item = byPath.get(relative); if (!item) throw fail(); return read(item.file, item.index); };
    const root = envelope(await readAt(MANAGED_IMAGE_MARKER)), marker = envelope(await readAt(markerPath));
    if (root?.version !== 1 || root.kind !== 'immutable-prompt-images' || !/^[a-f0-9-]{36}$/.test(root.id ?? '') || roleplayHash(root) !== roleplayHash(marker)) throw fail();
    withOperation(context, ({ lease }) => checkManagedImageDestination(roleplayLease(lease).scope.directories));
    for (const { file, index } of selected) {
        if ([MANAGED_IMAGE_MARKER, markerPath].includes(file.relative)) { map.set(index, { kind: 'marker' }); continue; }
        const name = file.relative.slice(MANAGED_IMAGE_PREFIX.length + 1);
        if (name.endsWith('.record.json')) {
            if (!assetPattern.test(name.slice(0, -12)) || !byPath.has(file.relative.slice(0, -12))) throw fail();
            map.set(index, { kind: 'record' }); continue;
        }
        if (!assetPattern.test(name)) throw fail();
        const image = imageFrom(await read(file, index), name);
        const record = envelope(await readAt(file.relative + '.record.json'));
        if (roleplayHash(record) !== roleplayHash({ version: 1, rawHash: image.rawHash, size: image.bytes.length, extension: image.extension })) throw fail();
        withOperation(context, ({ lease }) => checkManagedImageDestination(roleplayLease(lease).scope.directories, image));
        map.set(index, { kind: 'image', name, rawHash: image.rawHash });
    }
    return map;
}
export function publishManagedImportLocked(lease, descriptor, input) {
    const directories = roleplayLease(lease).scope.directories;
    if (descriptor.kind === 'image') {
        const image = imageFrom(input, descriptor.name);
        if (image.rawHash !== descriptor.rawHash) throw fail();
        publishManagedImage(directories, image);
    } else if (descriptor.kind === 'marker') ensureManagedImageNamespace(directories);
    else if (descriptor.kind !== 'record') throw fail();
}
export function assertOrdinaryImportPath(relative) {
    if (managedImportPath(relative)) throw operationError(uiText('This import was started by an older version and includes compatible copies. Start the import again so they can be checked.'), 409);
}

/** Missing portable files must not leave newly imported protected references unusable. */
export function assertManagedChatDependencies(context, plan, file, bytes, managed) {
    if (file.target.resource?.kind !== 'chat') return;
    const parsed = parseChatJsonl(bytes);
    if (parsed.status !== 'ok') return; // Existing chat validation reports malformed source separately.
    const urls = new Set();
    const add = url => { if (typeof url === 'string' && url.startsWith('/' + MANAGED_IMAGE_PREFIX + '/')) urls.add(url); };
    const extra = value => {
        if (!value || typeof value !== 'object') return;
        add(value.image); add(value.image_url);
        if (Array.isArray(value.image_swipes)) value.image_swipes.forEach(add);
        if (Array.isArray(value.media)) for (const item of value.media) { add(item?.url); add(item?.neconyan_prompt?.image_url); }
    };
    for (const record of parsed.records.slice(1)) {
        extra(record.extra);
        if (Array.isArray(record.swipe_info)) record.swipe_info.forEach(swipe => extra(swipe?.extra));
    }
    const incoming = new Set([...managed.keys()].filter(index => managed.get(index).kind === 'image').map(index => '/' + plan.files[index].relative));
    withOperation(context, ({ lease }) => {
        for (const url of urls) if (!incoming.has(url)) verifyManagedImage(roleplayLease(lease).scope.directories, url);
    });
}
