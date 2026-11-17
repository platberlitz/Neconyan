import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/scripts/extensions/connection-manager/index.js', import.meta.url), 'utf8');
const render = source.match(/^function renderConnectionProfiles\([^]*?\n}$/m)?.[0];

function renderProfiles(profiles, folders, selectedProfile) {
    const element = tagName => ({
        tagName,
        children: [],
        dataset: {},
        appendChild(child) { this.children.push(child); },
        setAttribute(name, value) { this[name] = value; },
    });
    const select = element('select');
    const context = vm.createContext({
        document: { createElement: element },
        extension_settings: { connectionManager: { selectedProfile } },
        getSortedProfiles: () => profiles.slice().sort((a, b) => a.name.localeCompare(b.name)),
        getSortedFolders: () => folders.slice().sort((a, b) => a.name.localeCompare(b.name)),
        NONE: '<None>',
        t: strings => strings[0],
        select,
    });
    vm.runInContext(`${render}\nrenderConnectionProfiles(select);`, context);
    return select.children;
}

test('favourites appear only in their group and keep their selection and folder', () => {
    const profiles = [
        { id: 'root-fav', name: 'Amber', fav: true, folderId: null },
        { id: 'folder-fav', name: 'Basil', fav: true, folderId: 'mixed' },
        { id: 'only-fav', name: 'Clover', fav: true, folderId: 'only' },
        { id: 'root', name: 'Daisy', fav: false, folderId: null },
        { id: 'folder', name: 'Elm', fav: false, folderId: 'mixed' },
    ];
    const folders = [{ id: 'mixed', name: 'Mixed' }, { id: 'only', name: 'Only favourites' }];
    const children = renderProfiles(profiles, folders, 'folder-fav');
    expect(children.map(child => child.label || child.value)).toEqual(['', '★ Favorites', 'root', '📁 Mixed']);
    expect(children[1].children.map(option => option.value)).toEqual(['root-fav', 'folder-fav', 'only-fav']);
    expect(children[1].children[1]).toMatchObject({ selected: true, textContent: '★ Basil', dataset: { folderId: 'mixed', favorite: 'true' } });
    expect(children[3].children.map(option => option.value)).toEqual(['folder']);

    profiles[1].fav = false;
    const after = renderProfiles(profiles, folders, 'folder-fav');
    expect(after[3].children.map(option => option.value)).toEqual(['folder-fav', 'folder']);
    expect(after[3].children[0]).toMatchObject({ selected: true, textContent: 'Basil', dataset: { folderId: 'mixed', favorite: 'false' } });
});

test('ordinary profiles and the empty selection remain in their existing places', () => {
    const children = renderProfiles([
        { id: 'root', name: 'Amber', fav: false, folderId: null },
        { id: 'folder', name: 'Basil', fav: false, folderId: 'mixed' },
    ], [{ id: 'mixed', name: 'Mixed' }], null);
    expect(children.map(child => child.label || child.value)).toEqual(['', 'root', '📁 Mixed']);
    expect(children[0]).toMatchObject({ value: '', selected: true });
    expect(children[2].children.map(option => option.value)).toEqual(['folder']);
});
