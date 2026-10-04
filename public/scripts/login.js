/**
 * CRSF token for requests.
 */
let csrfToken = '';
let discreetLogin = false;

/**
 * Gets a CSRF token from the server.
 * @returns {Promise<string>} CSRF token
 */
async function getCsrfToken() {
    const response = await fetch('/csrf-token', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
        },
    });
    const data = await response.json();
    return data.token;
}

/**
 * Gets a list of users from the server.
 * @returns {Promise<object>} List of users
 */
async function getUserList() {
    const response = await fetch('/api/users/list', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
    });

    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Could not load your accounts. Refresh to try again.');
    }

    if (response.status === 204) {
        discreetLogin = true;
        return [];
    }

    const userListObj = await response.json();
    console.log(userListObj);
    return userListObj;
}

/**
 * Gets the browser authentication status from the server.
 * @returns {Promise<{authenticated: boolean, browserSession: boolean, accountsEnabled: boolean, basicAuthMode: boolean}>} Status
 */
async function getAuthStatus() {
    const response = await fetch('/api/auth/status', {
        cache: 'no-store',
        credentials: 'same-origin',
    });
    if (!response.ok) {
        throw new Error('Could not load the sign-in page. Refresh to try again.');
    }
    return response.json();
}

/**
 * Requests a recovery code for the user.
 * @param {string} handle User handle
 * @returns {Promise<void>}
 */
async function sendRecoveryPart1(handle) {
    const response = await fetch('/api/users/recover-step1', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify({ handle }),
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    showRecoveryBlock();
}

/**
 * Sets a new password for the user using the recovery code.
 * @param {string} handle User handle
 * @param {string} code Recovery code
 * @param {string} newPassword New password
 * @returns {Promise<void>}
 */
async function sendRecoveryPart2(handle, code, newPassword) {
    const recoveryData = {
        handle,
        code,
        newPassword,
    };

    const response = await fetch('/api/users/recover-step2', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
        },
        body: JSON.stringify(recoveryData),
    });

    if (!response.ok) {
        const errorData = await response.json();
        return displayError(errorData.error || 'An error occurred');
    }

    console.log(`Successfully recovered password for ${handle}!`);
    await performLogin(handle, newPassword);
}

/**
 * Attempts to log in the user.
 * @param {string} handle User's handle
 * @param {string} password User's password
 * @returns {Promise<void>}
 */
async function performLogin(handle, password) {
    const userInfo = {
        handle: handle,
        password: password,
    };

    try {
        const response = await fetch('/api/users/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify(userInfo),
        });

        if (!response.ok) {
            const errorData = await response.json();
            return displayError(errorData.error || 'An error occurred');
        }

        const data = await response.json();

        if (data.handle) {
            console.log(`Successfully logged in as ${handle}!`);
            redirectToHome();
        }
    } catch (error) {
        console.error('Error logging in:', error);
        displayError(String(error));
    }
}

/**
 * Signs in to the shared workspace login with a username and password.
 * @param {string} username Workspace username
 * @param {string} password Workspace password
 * @param {boolean} remember Remember this device for 30 days
 * @returns {Promise<void>}
 */
async function performWorkspaceLogin(username, password, remember) {
    const button = $('#workspaceLoginButton').prop('disabled', true);
    try {
        const response = await fetch('/api/auth/browser/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ username, password, remember }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            return displayError(data.error || 'That name or password did not match.');
        }
        redirectToHome();
    } catch (error) {
        console.error('Workspace login failed:', error);
        displayError('Could not reach the server. Refresh to try again.');
    } finally {
        button.prop('disabled', false);
    }
}

/**
 * Signs in with a passkey bound to the shared workspace login.
 * @param {boolean} remember Remember this device for 30 days
 * @returns {Promise<void>}
 */
async function performPasskeyLogin(remember) {
    const button = $('#passkeyLoginButton').prop('disabled', true);
    try {
        const optionsResponse = await fetch('/api/auth/passkeys/login-options', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({ remember }),
        });
        const optionsData = await optionsResponse.json().catch(() => ({}));
        if (!optionsResponse.ok) {
            return displayError(optionsData.error || 'Could not start the passkey sign-in.');
        }

        const options = optionsData.options;
        const credential = await navigator.credentials.get({
            publicKey: {
                challenge: base64urlToBuffer(options.challenge),
                rpId: options.rpId,
                userVerification: options.userVerification || 'preferred',
                timeout: options.timeout || 60000,
            },
        });
        if (!credential) {
            return displayError('No passkey was chosen.');
        }

        const verifyResponse = await fetch('/api/auth/passkeys/login', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken,
            },
            body: JSON.stringify({
                challengeId: optionsData.challengeId,
                remember,
                response: {
                    id: credential.id,
                    rawId: bufferToBase64url(new Uint8Array(credential.rawId)),
                    type: credential.type,
                    authenticatorAttachment: credential.authenticatorAttachment,
                    clientExtensionResults: credential.getClientExtensionResults?.() ?? {},
                    response: {
                        clientDataJSON: bufferToBase64url(new Uint8Array(credential.response.clientDataJSON)),
                        authenticatorData: bufferToBase64url(new Uint8Array(credential.response.authenticatorData)),
                        signature: bufferToBase64url(new Uint8Array(credential.response.signature)),
                        userHandle: credential.response.userHandle ? bufferToBase64url(new Uint8Array(credential.response.userHandle)) : null,
                    },
                },
            }),
        });
        const verifyData = await verifyResponse.json().catch(() => ({}));
        if (!verifyResponse.ok) {
            return displayError(verifyData.error || 'The passkey did not verify.');
        }
        redirectToHome();
    } catch (error) {
        if (error?.name === 'NotAllowedError') {
            return displayError('Sign-in was cancelled or timed out.');
        }
        console.error('Passkey sign-in failed:', error);
        displayError(error.message || 'The passkey did not verify.');
    } finally {
        button.prop('disabled', false);
    }
}

/**
 * Decodes a base64url string into the byte array the WebAuthn API expects.
 * @param {string} value Base64url string
 * @returns {Uint8Array} Decoded bytes
 */
function base64urlToBuffer(value) {
    const padding = '='.repeat((4 - (String(value).length % 4)) % 4);
    const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/') + padding;
    const raw = atob(base64);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) {
        bytes[i] = raw.charCodeAt(i);
    }
    return bytes;
}

/**
 * Encodes bytes into a base64url string for the server.
 * @param {Uint8Array} bytes Raw bytes
 * @returns {string} Base64url string
 */
function bufferToBase64url(bytes) {
    let base64 = btoa(String.fromCharCode(...bytes));
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Handles the user selection event.
 * @param {object} user User object
 * @returns {Promise<void>}
 */
async function onUserSelected(user) {
    // No password, just log in
    if (!user.password) {
        return await performLogin(user.handle, '');
    }

    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    $('#loginButton').off('click').on('click', async () => {
        const password = String($('#userPassword').val());
        await performLogin(user.handle, password);
    });

    $('#recoverPassword').off('click').on('click', async () => {
        await sendRecoveryPart1(user.handle);
    });

    $('#sendRecovery').off('click').on('click', async () => {
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(user.handle, code, newPassword);
    });

    displayError('');
}

/**
 * Displays an error message to the user.
 * @param {string} message Error message
 */
function displayError(message) {
    $('#errorMessage').text(message);
}

/**
 * Redirects the user to the home page.
 * Preserves the query string.
 */
function redirectToHome() {
    // Create a URL object based on the current location
    const currentUrl = new URL(window.location.href);

    // After a login there's no need to preserve the
    // noauto parameter (if present)
    currentUrl.searchParams.delete('noauto');

    // Set the pathname to root and keep the updated query string
    // Keep a reverse proxy's installation prefix. No user-controlled return URL.
    currentUrl.pathname = currentUrl.pathname.replace(/\/login\/?$/, '/') || '/';

    // Redirect to the new URL
    window.location.href = currentUrl.toString();
}

/**
 * Hides the password entry block and shows the password recovery block.
 */
function showRecoveryBlock() {
    $('#passwordEntryBlock').hide();
    $('#passwordRecoveryBlock').show();
    displayError('');
}

/**
 * Hides the password recovery block and shows the password entry block.
 */
function onCancelRecoveryClick() {
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    displayError('');
}

/**
 * Configures the login page for normal login.
 * @param {import('../../src/users').UserViewModel[]} userList List of users
 */
function configureNormalLogin(userList) {
    console.log('Discreet login is disabled');
    $('#handleEntryBlock').hide();
    $('#normalLoginPrompt').show();
    $('#discreetLoginPrompt').hide();
    console.log(userList);
    for (const user of userList) {
        const userBlock = $('<button type="button"></button>').addClass('userSelect');
        const avatarBlock = $('<div></div>').addClass('avatar');
        avatarBlock.append($('<img>').attr('src', user.avatar));
        userBlock.append(avatarBlock);
        userBlock.append($('<span></span>').addClass('userName').text(user.name));
        userBlock.append($('<small></small>').addClass('userHandle').text(user.handle));
        userBlock.on('click', () => onUserSelected(user));
        $('#userList').append($('<li></li>').append(userBlock));
    }
}

/**
 * Configures the login page for discreet login.
 */
function configureDiscreetLogin() {
    console.log('Discreet login is enabled');
    $('#handleEntryBlock').show();
    $('#normalLoginPrompt').hide();
    $('#discreetLoginPrompt').show();
    $('#userList').hide();
    $('#passwordRecoveryBlock').hide();
    $('#passwordEntryBlock').show();
    $('#loginButton').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const password = String($('#userPassword').val());
        await performLogin(handle, password);
    });

    $('#recoverPassword').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        await sendRecoveryPart1(handle);
    });

    $('#sendRecovery').off('click').on('click', async () => {
        const handle = String($('#userHandle').val());
        const code = String($('#recoveryCode').val());
        const newPassword = String($('#newPassword').val());
        await sendRecoveryPart2(handle, code, newPassword);
    });
}

(async function () {
    try {
        csrfToken = await getCsrfToken();
        const status = await getAuthStatus();
        if (status.basicAuthMode && status.browserSession && !status.accountsEnabled) return redirectToHome();
        const passkeysSupported = 'PublicKeyCredential' in window && !!navigator.credentials?.get;

        if (status.basicAuthMode && !status.browserSession) {
            $('#workspaceLoginBlock').show();
            $('#rememberBlock').show();
            if (passkeysSupported && status.passkeysEnabled) {
                $('#passkeyLoginBlock').show();
                $('#loginDivider').show();
            }
        }

        if (status.accountsEnabled && (!status.basicAuthMode || status.browserSession)) {
            const userList = await getUserList();
            $('#userSelectBlock').show();
            if (discreetLogin) {
                configureDiscreetLogin();
            } else {
                configureNormalLogin(userList);
            }
        } else {
            $('#userSelectBlock').hide();
        }
    } catch (error) {
        displayError(error.message || 'Could not connect. Refresh to try again.');
    }
    document.getElementById('shadow_popup').style.opacity = '';
    $('#cancelRecovery').on('click', onCancelRecoveryClick);
    $('#workspaceLoginForm').on('submit', (evt) => {
        evt.preventDefault();
        const username = String($('#workspaceUsername').val() || '').trim();
        const password = String($('#workspacePassword').val() || '');
        if (!username) {
            return displayError('Type your username first.');
        }
        if (!password) {
            return displayError('Type your password first.');
        }
        displayError('');
        return performWorkspaceLogin(username, password, $('#rememberDevice').is(':checked'));
    });
    $('#passkeyLoginButton').on('click', () => {
        displayError('');
        return performPasskeyLogin($('#rememberDevice').is(':checked'));
    });
    $(document).on('keydown', (evt) => {
        if (evt.key === 'Enter' && document.activeElement.tagName === 'INPUT') {
            const id = document.activeElement.id;
            if (id === 'workspaceUsername' || id === 'workspacePassword' || id === 'rememberDevice') {
                return;
            }
            if ($('#passwordRecoveryBlock').is(':visible')) {
                $('#sendRecovery').trigger('click');
            } else {
                $('#loginButton').trigger('click');
            }
        }
    });
})();
