export const CARD_SCRIPT_PROTOCOL_VERSION = 2;
export const CARD_SCRIPT_SANDBOX_PATH = '/sandbox/card-script';
export const MAX_CARD_DOCUMENT_LENGTH = 4 * 1024 * 1024;
export const CARD_SCRIPT_CONNECTION_ALLOWLIST = '();webrtc=block;report-to=neconyan-card-isolation';
export const CARD_SCRIPT_SANDBOX_CSP = 'default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src \'none\'; frame-src \'none\'; child-src \'none\'; worker-src \'none\'; object-src \'none\'; form-action \'none\'; base-uri \'none\'';
export const CARD_SCRIPT_PERMISSIONS = 'accelerometer \'none\'; autoplay \'none\'; camera \'none\'; clipboard-read \'none\'; clipboard-write \'none\'; display-capture \'none\'; encrypted-media \'none\'; fullscreen \'none\'; geolocation \'none\'; gyroscope \'none\'; magnetometer \'none\'; microphone \'none\'; midi \'none\'; payment \'none\'; picture-in-picture \'none\'; publickey-credentials-get \'none\'; screen-wake-lock \'none\'; usb \'none\'; web-share \'none\'; xr-spatial-tracking \'none\'';
