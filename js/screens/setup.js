/* Server discovery + login. Supports password and Quick Connect. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var pollTimer = null;
    var step = 'server';
    var pendingServer = null;
    var rootEl = null;
    var screenEl = null;
    /* True when the viewer reached the server step from the account picker, so
       Back returns there instead of pretending the picker never existed. */
    var fromPicker = false;

    function setError(message) {
        var node = U.$('#setupErr');
        if (node) node.textContent = message || '';
    }

    /* Every field starts navigable; the keyboard layout (and the keyboard) only
       appears while one is being edited. */
    function arm(input) {
        return UI.textField(input, {
            onStart: function () { if (screenEl) screenEl.classList.add('typing'); },
            onStop: function () { if (screenEl) screenEl.classList.remove('typing'); }
        });
    }

    function serverLabel(account) {
        if (account.serverName) return account.serverName;
        return String(account.serverUrl || '')
            .replace(/^https?:\/\//i, '').replace(/\/.*$/, '') || 'Jellyfin';
    }

    function accountStep() {
        var wrap = U.el('div', 'form-wrap');
        wrap.innerHTML =
            '<h1 class="form-title">Who\'s watching?</h1>' +
            '<p class="form-sub hint">Choose your profile, or add another server.</p>';

        var grid = U.el('div', 'account-grid');
        grid.setAttribute('data-row', 'accounts');

        var accounts = Store.accounts();
        for (var i = 0; i < accounts.length; i++) {
            var account = accounts[i];
            var card = U.el('button', 'account-card');
            card.type = 'button';
            UI.focusable(card, (account.userName || 'Jellyfin user') + ' on ' + serverLabel(account));
            card.setAttribute('data-key', 'account:' + account.id);
            card.appendChild(U.el('span', 'account-initial',
                String(account.userName || '?').charAt(0).toUpperCase()));
            card.appendChild(U.el('span', 'account-name', account.userName || 'Jellyfin user'));
            card.appendChild(U.el('span', 'account-server', serverLabel(account)));
            card.onclick = (function (id) {
                return function () { App.switchAccount(id); };
            })(account.id);
            grid.appendChild(card);
        }

        var add = U.el('button', 'account-card add');
        add.type = 'button';
        UI.focusable(add, 'Add account');
        add.setAttribute('data-key', 'account:add');
        add.appendChild(U.el('span', 'account-initial', '+'));
        add.appendChild(U.el('span', 'account-name', 'Add account'));
        add.appendChild(U.el('span', 'account-server', 'New login'));
        add.onclick = function () {
            fromPicker = true;
            step = 'server';
            render();
        };
        grid.appendChild(add);

        wrap.appendChild(grid);
        rootEl.appendChild(wrap);

        setTimeout(function () { U.focusFirst(wrap); }, 60);
    }

    function serverStep() {
        var wrap = U.el('div', 'form-wrap');
        wrap.innerHTML =
            '<h1 class="form-title">Connect to Jellyfin</h1>' +
            '<p class="form-sub hint">Enter the address of your Jellyfin server. It must be reachable from the TV ' +
            'on your home network, for example <b>192.168.1.20:8096</b> or <b>https://jellyfin.example.com</b>.</p>' +
            '<div class="field"><label for="serverUrl">Server address</label>' +
            '<input id="serverUrl" name="serverUrl" data-focusable tabindex="-1" type="text" autocomplete="url" aria-describedby="setupErr" ' +
            'inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" ' +
            'placeholder="192.168.1.20:8096"></div>' +
            '<div class="err" id="setupErr" role="alert" aria-live="assertive"></div>' +
            '<div class="btn-row" data-row="actions">' +
            '<button class="btn primary" id="connectBtn" data-focusable tabindex="-1">Connect</button>' +
            '</div>' +
            '<div class="status-line" id="serverInfo" aria-live="polite"></div>';

        rootEl.appendChild(wrap);

        var input = U.$('#serverUrl');
        input.value = Store.get('lastServer', '');
        arm(input);
        var button = UI.iconize(U.$('#connectBtn'), 'check', 'Connect');
        var busy = false;

        function connect() {
            if (busy) return;
            var value = Api.normalizeServerUrl(input.value);
            if (!value) { setError('Please enter a server address.'); return; }

            busy = true;
            setError('');
            U.$('#serverInfo').textContent = 'Contacting server\u2026';
            button.labelNode.textContent = 'Connecting\u2026';

            Api.publicInfo(value).then(function (info) {
                busy = false;
                pendingServer = { url: value, name: info.ServerName || 'Jellyfin', version: info.Version };
                Store.set('lastServer', value);
                Api.configure({
                    serverUrl: value,
                    deviceId: Store.deviceId(),
                    deviceName: Store.deviceName()
                });
                step = 'login';
                render();
            }).catch(function (err) {
                busy = false;
                button.labelNode.textContent = 'Connect';
                U.$('#serverInfo').textContent = '';
                setError('Could not reach that server (' + (err && err.message ? err.message : 'network error') + '). Check the address and that the TV is on the same network.');
            });
        }

        button.onclick = connect;
        /* Down from the field must land on Connect, not on whichever element
           happens to be closest by geometry. */
        input.onkeydown = function (event) {
            if (event.keyCode === 13) { event.preventDefault(); connect(); return; }
            if (event.keyCode === 40) {
                event.preventDefault(); event.stopPropagation();
                button.focus();
            }
        };

        setTimeout(function () { input.focus(); }, 60);
    }

    function loginStep() {
        var wrap = U.el('div', 'form-wrap');
        wrap.innerHTML =
            '<h1 class="form-title">' + U.esc(pendingServer.name) + '</h1>' +
            '<p class="form-sub">' + U.esc(pendingServer.url) +
            (pendingServer.version ? ' &middot; Jellyfin ' + U.esc(pendingServer.version) : '') + '</p>' +
            '<div class="field"><label for="username">Username</label>' +
            '<input id="username" name="username" data-focusable tabindex="-1" type="text" autocomplete="username" aria-describedby="setupErr" ' +
            'autocapitalize="off" spellcheck="false"></div>' +
            '<div class="field"><label for="password">Password</label>' +
            '<input id="password" name="password" data-focusable tabindex="-1" type="password" autocomplete="current-password" aria-describedby="setupErr"></div>' +
            '<div class="err" id="setupErr" role="alert" aria-live="assertive"></div>' +
            '<div class="btn-row" data-row="actions">' +
            '<button class="btn primary" id="loginBtn" data-focusable tabindex="-1">Sign In</button>' +
            '<button class="btn" id="quickBtn" data-focusable tabindex="-1">Quick Connect</button>' +
            '<button class="btn ghost" id="backBtn" data-focusable tabindex="-1">Back</button>' +
            '</div>';

        if (Api.isInsecureRemote(pendingServer.url)) {
            var warn = U.el('div', 'err', 'Warning: this address uses plain HTTP over the internet, so your ' +
                'password is sent unencrypted. Prefer an https:// address.');
            var sub = wrap.querySelector('.form-sub');
            if (sub && sub.nextSibling) wrap.insertBefore(warn, sub.nextSibling);
        }

        rootEl.appendChild(wrap);

        var username = U.$('#username');
        var password = U.$('#password');

        /* The on-screen keyboard hides half the TV, so the viewer needs to see
           what they type. A password input can only ever show dots; a text input
           masked with CSS can show the characters while it has focus and dots
           the rest of the time. Engines without the property keep type=password. */
        if (document.body.style.webkitTextSecurity !== undefined) {
            password.type = 'text';
            password.className = 'secret';
            password.setAttribute('autocomplete', 'off');
            password.setAttribute('autocapitalize', 'off');
            password.setAttribute('autocorrect', 'off');
            password.setAttribute('spellcheck', 'false');
        }
        arm(username);
        arm(password);
        var loginBtn = UI.iconize(U.$('#loginBtn'), 'check', 'Sign In');
        UI.iconize(U.$('#quickBtn'), 'users', 'Quick Connect');
        UI.iconize(U.$('#backBtn'), 'back', 'Back');
        var busy = false;

        function login() {
            if (busy) return;
            if (!username.value) { setError('Enter your username.'); return; }

            busy = true;
            setError('');
            loginBtn.labelNode.textContent = 'Signing\u2026';

            Api.authenticate(username.value, password.value).then(function (result) {
                result.serverName = pendingServer.name;
                Store.saveAuth(result);
                Api.configure({
                    serverUrl: result.serverUrl,
                    token: result.token,
                    userId: result.userId,
                    deviceId: Store.deviceId(),
                    deviceName: Store.deviceName()
                });
                App.afterLogin();
            }).catch(function (err) {
                busy = false;
                loginBtn.labelNode.textContent = 'Sign In';
                setError(err && err.status === 401 ? 'Wrong username or password.' : ('Sign in failed: ' + (err.message || 'unknown error')));
            });
        }

        loginBtn.onclick = login;
        username.onkeydown = function (event) {
            if (event.keyCode === 13) { event.preventDefault(); password.focus(); return; }
            if (event.keyCode === 40) {
                event.preventDefault(); event.stopPropagation();
                password.focus();
            }
        };
        password.onkeydown = function (event) {
            if (event.keyCode === 13) { event.preventDefault(); login(); return; }
            if (event.keyCode === 40) {
                event.preventDefault(); event.stopPropagation();
                loginBtn.focus();
            }
        };

        U.$('#backBtn').onclick = function () {
            step = fromPicker && Store.accounts().length ? 'accounts' : 'server';
            render();
        };
        U.$('#quickBtn').onclick = function () { step = 'quick'; render(); };

        setTimeout(function () { username.focus(); }, 60);
    }

    function quickStep() {
        var wrap = U.el('div', 'form-wrap center');
        wrap.innerHTML =
            '<h1 class="form-title">Quick Connect</h1>' +
            '<p class="form-sub">On your phone or computer, open Jellyfin &rarr; Settings &rarr; Quick Connect ' +
            'and enter this code.</p>' +
            '<div class="code-big" id="qcCode" aria-live="polite">----</div>' +
            '<div class="status-line" id="qcStatus" aria-live="polite">Requesting a code\u2026</div>' +
            '<div class="err" id="setupErr" role="alert" aria-live="assertive"></div>' +
            '<div class="btn-row" data-row="actions" style="justify-content:center">' +
            '<button class="btn ghost" id="cancelBtn" data-focusable tabindex="-1">Cancel</button>' +
            '</div>';

        rootEl.appendChild(wrap);

        var stopped = false;
        var secret = null;

        UI.iconize(U.$('#cancelBtn'), 'close', 'Cancel');

        U.$('#cancelBtn').onclick = function () {
            stopped = true;
            if (pollTimer) clearTimeout(pollTimer);
            step = 'login';
            render();
        };

        Api.quickConnectEnabled().then(function (enabled) {
            if (!enabled) throw new Error('Quick Connect is disabled on this server');
            return Api.quickConnectInitiate();
        }).then(function (result) {
            if (stopped) return;
            secret = result.Secret;
            U.$('#qcCode').textContent = result.Code;
            U.$('#qcStatus').textContent = 'Waiting for approval\u2026';

            function poll() {
                if (stopped) return;
                Api.quickConnectPoll(secret).then(function (status) {
                    if (stopped) return;
                    if (status && status.Authenticated) {
                        Api.quickConnectAuthenticate(secret).then(function (auth) {
                            auth.serverName = pendingServer.name;
                            Store.saveAuth(auth);
                            Api.configure({
                                serverUrl: auth.serverUrl,
                                token: auth.token,
                                userId: auth.userId,
                                deviceId: Store.deviceId(),
                                deviceName: Store.deviceName()
                            });
                            App.afterLogin();
                        }).catch(function (err) {
                            setError('Sign in failed: ' + (err.message || 'unknown'));
                        });
                        return;
                    }
                    pollTimer = setTimeout(poll, 2000);
                }).catch(function () {
                    pollTimer = setTimeout(poll, 3000);
                });
            }
            poll();
        }).catch(function (err) {
            setError(err.message || 'Quick Connect unavailable');
            U.$('#qcStatus').textContent = 'You can still sign in with your password.';
        });

        setTimeout(function () { U.$('#cancelBtn').focus(); }, 60);
    }

    function render() {
        U.clear(rootEl);
        if (screenEl) screenEl.classList.remove('typing');
        if (step === 'accounts') accountStep();
        else if (step === 'server' || !pendingServer) serverStep();
        else if (step === 'login') loginStep();
        else quickStep();
    }

    window.Screens.setup = {
        render: function (container) {
            rootEl = container;
            /* Accounts already on this TV mean someone is signed in somewhere:
               the picker comes first, and "Add account" leads to the form. */
            step = Store.accounts().length ? 'accounts' : 'server';
            fromPicker = false;
            pendingServer = null;
            var screen = U.el('div', 'screen setup');
            screenEl = screen;
            screen.appendChild(U.el('div', 'setup-glow'));

            var brand = U.el('div', 'setup-brand');
            var mark = U.el('div', 'wordmark');
            mark.innerHTML = 'Jelly<br><em>Lean</em>';
            mark.setAttribute('aria-label', 'JellyLean');
            brand.appendChild(mark);
            brand.appendChild(U.el('p', '', 'A quiet Jellyfin client, made for the sofa and a remote.'));
            screen.appendChild(brand);

            var panel = U.el('main', 'setup-panel');
            screen.appendChild(panel);
            container.appendChild(screen);
            rootEl = panel;
            render();
        },

        destroy: function () {
            if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }

            /* Adding an account probes a server, and that clears the token the
               current session is using. Backing out to Settings must put the
               old session back, or the next API call looks like a 401. */
            var auth = Store.auth();
            if (auth.token && Api.token !== auth.token) {
                Api.configure({
                    serverUrl: auth.serverUrl,
                    token: auth.token,
                    userId: auth.userId,
                    deviceId: Store.deviceId(),
                    deviceName: Store.deviceName()
                });
            }
        }
    };
})(window);
