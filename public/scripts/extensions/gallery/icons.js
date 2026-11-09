/** Use the app's SVG set for the gallery's built-in font-icon slots. */
const names = {
    thumbnailAlbum: 'folder', thumbnailImage: 'image', breadcrumbAlbum: 'folder', breadcrumbHome: 'house',
    breadcrumbSeparator: 'chevron-left', breadcrumbSeparatorRtl: 'chevron-right',
    navigationFilterSelected: 'check', navigationFilterUnselected: 'circle', navigationFilterSelectedAll: 'rotate-left',
    navigationPaginationPrevious: 'chevron-left', navigationPaginationNext: 'chevron-right',
    thumbnailSelected: 'circle-check', thumbnailUnselected: 'circle', thumbnailFeatured: 'star', thumbnailCounter: 'images',
    thumbnailShare: 'share', thumbnailDownload: 'download', thumbnailInfo: 'circle-info', thumbnailShoppingcart: 'box-open',
    thumbnailDisplay: 'maximize', thumbnailAlbumUp: 'chevron-up', paginationNext: 'chevron-right', paginationPrevious: 'chevron-left',
    galleryMoreButton: 'images', buttonClose: 'xmark', viewerPrevious: 'chevron-left', viewerNext: 'chevron-right',
    viewerImgPrevious: 'chevron-left', viewerImgNext: 'chevron-right', viewerDownload: 'download',
    viewerToolbarMin: 'ellipsis-vertical', viewerToolbarStd: 'bars', viewerPlay: 'play', viewerPause: 'pause',
    viewerFullscreenOn: 'maximize', viewerFullscreenOff: 'compress', viewerZoomIn: 'plus', viewerZoomOut: 'minus',
    viewerLinkOriginal: 'arrow-up-right-from-square', viewerInfo: 'circle-info', viewerShare: 'share',
    viewerRotateLeft: 'rotate-left', viewerRotateRight: 'rotate-right', viewerShoppingcart: 'box-open',
    user: 'user', location: 'location-dot', picture: 'image', config: 'wrench', shareMail: 'envelope-open-text',
};

export const galleryIcons = Object.fromEntries(Object.entries(names).map(([slot, name]) => [slot, `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`]));
// The service name is clearer than a tiny re-drawn logo in this labelled share menu.
Object.assign(galleryIcons, { shareFacebook: 'Facebook', shareTwitter: 'X', shareTumblr: 'Tumblr', sharePinterest: 'Pinterest', shareVK: 'VK' });
