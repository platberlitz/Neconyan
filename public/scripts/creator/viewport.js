/** A same-section redraw must not move the drawer or close the user's disclosures. */
export function rememberCreatorViewport(host) {
    const positions = [];
    for (let node = host; node; node = node.parentElement) positions.push([node, node.scrollTop, node.scrollLeft]);
    const details = [...host.querySelectorAll('details')].map(node => node.open);
    const navLeft = host.querySelector('.creator-sections')?.scrollLeft ?? 0;
    return () => {
        host.querySelectorAll('details').forEach((node, index) => { if (details[index] !== undefined) node.open = details[index]; });
        const nav = host.querySelector('.creator-sections');
        if (nav) nav.scrollLeft = navLeft;
        for (const [node, top, left] of positions) { node.scrollTop = top; node.scrollLeft = left; }
    };
}
