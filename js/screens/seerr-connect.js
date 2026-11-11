/* Connect to Seerr: one short screen per option, opened from Settings, so
   nothing is typed until an option is chosen. The layout is the Setup login's
   "typing" layout: the field sits in the top half, above the TV keyboard.
   method: 'quick' | 'password' | 'key' | 'address' */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    /* Bumped when the screen closes so a Quick Connect still waiting stops. */
    var current = 0;

    /* Seerr usually runs next to Jellyfin on port 5055: start the address from
       that guess so it is one small edit instead of a whole URL. */
    function guess() {
        var match = /^http:\/\/([^\/:]+)/i.exec(Store.auth().serverUrl || '');
        return match ? 'http://' + match[1] + ':5055' : '';
    }

    window.Screens.seerrConnect = {
        render: function (container, params) {
            var method = (params && params.method) || 'quick';
            var auth = Store.auth();
            var mine = ++current;

            var screen = U.el('div', 'screen setup');
            screen.appendChild(U.el('div', 'setup-glow'));
            var brand = U.el('div', 'setup-brand');
            var mark = U.el('div', 'wordmark');
            mark.innerHTML = 'Jelly<br><em>Lean</em>';
            mark.setAttribute('aria-label', 'JellyLean');
            brand.appendChild(mark);
            brand.appendChild(U.el('p', '', 'Connect Seerr for Discover and requests.'));
            screen.appendChild(brand);
            var panel = U.el('main', 'setup-panel');
            screen.appendChild(panel);
            container.appendChild(screen);

            function alive() { return mine === current; }

            function leave(message) {
                if (message) U.toast(message);
                App.back();
            }

            function show(html) {
                U.clear(panel);
                screen.classList.remove('typing');
                var wrap = U.el('div', 'form-wrap');
                wrap.innerHTML = html;
                panel.appendChild(wrap);
                return wrap;
            }

            function setError(message) {
                var node = U.$('#seerrErr');
                if (node) node.textContent = message || '';
            }

            function fieldHtml(label, value, secret) {
                return '<div class="field"><label for="seerrInput">' + U.esc(label) + '</label>' +
                    '<input id="seerrInput" data-focusable tabindex="-1" type="text" autocomplete="off" ' +
                    'autocapitalize="off" autocorrect="off" spellcheck="false" value="' + U.esc(value || '') + '"' +
                    (secret ? ' class="secret"' : '') + '></div>';
            }

            /* Text field + action buttons. `submit` gets the typed value and
               returns a promise; a rejection is shown under the field. */
            function promptStep(spec) {
                show('<h1 class="form-title">' + U.esc(spec.title) + '</h1>' +
                    '<p class="form-sub">' + spec.sub + '</p>' +
                    fieldHtml(spec.label, spec.value, spec.secret) +
                    '<div class="err" id="seerrErr" role="alert" aria-live="assertive"></div>' +
                    '<div class="btn-row" data-row="actions">' +
                    '<button class="btn primary" id="seerrGo" data-focusable tabindex="-1">' + U.esc(spec.button) + '</button>' +
                    '<button class="btn ghost" id="seerrCancel" data-focusable tabindex="-1">Cancel</button>' +
                    '</div>');

                var input = U.$('#seerrInput');
                UI.textField(input, {
                    onStart: function () { screen.classList.add('typing'); },
                    onStop: function () { screen.classList.remove('typing'); }
                });
                var go = UI.iconize(U.$('#seerrGo'), 'check', spec.button);
                UI.iconize(U.$('#seerrCancel'), 'back', 'Cancel');
                var busy = false;

                function submit() {
                    if (busy) return;
                    var typed = input.value;
                    setError('');
                    busy = true;
                    go.labelNode.textContent = spec.busy || 'Working…';
                    Promise.resolve().then(function () { return spec.submit(typed); }).then(function () {
                        busy = false;
                    }, function (err) {
                        busy = false;
                        if (!alive()) return;
                        go.labelNode.textContent = spec.button;
                        setError((err && err.message) || 'Something went wrong.');
                    });
                }

                go.onclick = submit;
                U.$('#seerrCancel').onclick = function () { leave(); };
                input.onkeydown = function (event) {
                    if (event.keyCode === 13) { event.preventDefault(); submit(); return; }
                    if (event.keyCode === 40) {
                        event.preventDefault(); event.stopPropagation();
                        go.focus();
                    }
                };
                setTimeout(function () { input.focus(); }, 60);
            }

            function addressStep(next) {
                promptStep({
                    title: 'Seerr address',
                    sub: 'Where Seerr runs on your network, for example <b>http://192.168.1.10:5055</b>.',
                    label: 'Seerr address',
                    value: Seerr.url() || guess(),
                    button: next ? 'Continue' : 'Save',
                    submit: function (typed) {
                        var url = Seerr.normalizeUrl(typed.replace(/\s+/g, ''));
                        if (!url) throw new Error('That Seerr address is not valid.');
                        Seerr.setUrl(url);
                        if (next) next(); else leave('Seerr address saved');
                    }
                });
            }

            function passwordStep() {
                promptStep({
                    title: 'Jellyfin password',
                    sub: 'For <b>' + U.esc(auth.userName || 'your account') + '</b>. It is sent only to Seerr and is not stored.',
                    label: 'Password',
                    secret: true,
                    button: 'Sign In',
                    busy: 'Signing in…',
                    submit: function (typed) {
                        if (!typed) throw new Error('Enter your Jellyfin password.');
                        return Seerr.login(Seerr.url(), auth.userName, typed).then(function () {
                            if (alive()) leave('Connected to Seerr');
                        });
                    }
                });
                hidePasswordDots();
            }

            /* Dots while idle, the real characters while typing: the TV keyboard
               hides half the screen, so the viewer must see what they type. */
            function hidePasswordDots() {
                var input = U.$('#seerrInput');
                if (input && document.body.style.webkitTextSecurity === undefined) input.type = 'password';
            }

            function keyStep() {
                promptStep({
                    title: 'Seerr API key',
                    sub: 'Seerr &rarr; Settings &rarr; General &rarr; API Key.',
                    label: 'API key',
                    button: 'Save',
                    busy: 'Checking…',
                    submit: function (typed) {
                        var key = typed.replace(/\s+/g, '');
                        if (!key) throw new Error('Paste the Seerr API key.');
                        return Seerr.useKey(Seerr.url(), key).then(function () {
                            if (alive()) leave('Connected to Seerr');
                        });
                    }
                });
            }

            function quickStep() {
                var wrap = show('<h1 class="form-title">Quick Connect</h1>' +
                    '<p class="form-sub" id="seerrNote">Asking Jellyfin to approve this TV…</p>' +
                    '<div class="code-big" id="seerrCode" style="display:none" aria-live="polite"></div>' +
                    '<div class="err" id="seerrErr" role="alert" aria-live="assertive"></div>' +
                    '<div class="btn-row" data-row="actions">' +
                    '<button class="btn ghost" id="seerrCancel" data-focusable tabindex="-1">Cancel</button>' +
                    '</div>');
                UI.iconize(U.$('#seerrCancel'), 'close', 'Cancel');
                U.$('#seerrCancel').onclick = function () { leave(); };
                setTimeout(function () {
                    var cancel = U.$('#seerrCancel');
                    if (cancel) cancel.focus();
                }, 60);

                Seerr.quickConnect(Seerr.url(), {
                    isCancelled: function () { return !alive(); },
                    onCode: function (code) {
                        if (!alive()) return;
                        U.$('#seerrNote').innerHTML = 'This TV could not approve it by itself. On your phone or ' +
                            'computer open Jellyfin &rarr; Settings &rarr; Quick Connect and enter this code.';
                        var big = U.$('#seerrCode');
                        big.textContent = code;
                        big.style.display = '';
                    }
                }).then(function () {
                    if (alive()) leave('Connected to Seerr');
                }, function (err) {
                    if (!alive()) return;
                    U.$('#seerrNote').textContent = 'Quick Connect did not work.';
                    U.$('#seerrCode').style.display = 'none';
                    setError((err && err.message) || 'Something went wrong.');
                    var row = U.$('.btn-row', wrap);
                    var retry = UI.iconize(U.el('button', 'btn primary'), 'refresh', 'Try Again');
                    retry.id = 'seerrRetry';
                    retry.setAttribute('data-focusable', '');
                    retry.tabIndex = -1;
                    retry.onclick = function () { quickStep(); };
                    row.insertBefore(retry, row.firstChild);
                    U.focusNode(retry);
                });
            }

            function start() {
                if (method === 'password') passwordStep();
                else if (method === 'key') keyStep();
                else quickStep();
            }

            if (method === 'address') addressStep(null);
            else if (!Seerr.url()) addressStep(start);
            else start();
        },

        destroy: function () { current++; }
    };
})(window);
