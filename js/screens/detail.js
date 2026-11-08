/* Item detail: backdrop-led hero, overview, cast, technical facts, similar
   titles and the episode list for series. */
(function (global) {
    'use strict';

    window.Screens = window.Screens || {};

    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    var CODEC_NAMES = {
        truehd: 'TrueHD', ac3: 'AC3', eac3: 'EAC3', dts: 'DTS', dtshd: 'DTS-HD',
        aac: 'AAC', mp3: 'MP3', flac: 'FLAC', opus: 'Opus', vorbis: 'Vorbis',
        h264: 'H.264', hevc: 'HEVC', mpeg2video: 'MPEG-2', av1: 'AV1'
    };

    var LANGUAGE_NAMES = {
        eng: 'English', ron: 'Romanian', fra: 'French', deu: 'German',
        spa: 'Spanish', ita: 'Italian', por: 'Portuguese', rus: 'Russian',
        jpn: 'Japanese', kor: 'Korean', zho: 'Chinese', chi: 'Chinese',
        ara: 'Arabic', bul: 'Bulgarian', ces: 'Czech', dan: 'Danish',
        nld: 'Dutch', est: 'Estonian', fin: 'Finnish', ell: 'Greek',
        heb: 'Hebrew', hrv: 'Croatian', hun: 'Hungarian', isl: 'Icelandic',
        lav: 'Latvian', lit: 'Lithuanian', nor: 'Norwegian', pol: 'Polish',
        slk: 'Slovak', slv: 'Slovenian', swe: 'Swedish', tur: 'Turkish',
        ukr: 'Ukrainian', hin: 'Hindi', tha: 'Thai', vie: 'Vietnamese'
    };

    function languageName(code) {
        if (!code) return '';
        var key = String(code).toLowerCase();
        return LANGUAGE_NAMES[key] || String(code).toUpperCase();
    }

    function codecName(code) {
        if (!code) return '';
        var key = String(code).toLowerCase();
        return CODEC_NAMES[key] || String(code).toUpperCase();
    }

    function formatDate(value) {
        if (!value) return '';
        var match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
        if (!match) return String(value);
        var month = MONTHS[Number(match[2]) - 1];
        if (!month) return match[1];
        return Number(match[3]) + ' ' + month + ' ' + match[1];
    }

    function firstStream(item, type) {
        var streams = (item.MediaStreams || []);
        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Type === type) return streams[i];
        }
        return null;
    }

    function sourceOf(item) {
        return (item.MediaSources && item.MediaSources.length) ? item.MediaSources[0] : null;
    }

    function videoSummary(item) {
        var video = firstStream(item, 'Video');
        if (!video) return '';
        var parts = [];
        if (video.Width && video.Height) parts.push(video.Width + '\u00d7' + video.Height);
        var codec = codecName(video.Codec);
        if (codec) parts.push(codec + (video.VideoRangeType && video.VideoRangeType !== 'SDR' ? ' HDR' : ''));
        if (video.BitDepth && video.BitDepth > 8) parts.push(video.BitDepth + '-bit');
        return parts.join(' \u00b7 ');
    }

    function audioSummary(item) {
        var audio = firstStream(item, 'Audio');
        if (!audio) return '';
        var parts = [codecName(audio.Codec)];
        if (audio.ChannelLayout) parts.push(audio.ChannelLayout);
        else if (audio.Channels) parts.push(audio.Channels + 'ch');
        var language = languageName(audio.Language);
        return parts.join(' ') + (language ? ' \u00b7 ' + language : '');
    }

    function personImageUrl(person) {
        if (!person || !person.Id) return '';
        var query = '/Items/' + person.Id + '/Images/Primary?maxWidth=240&quality=84&api_key=' +
            encodeURIComponent(Api.token);
        if (person.PrimaryImageTag) query += '&tag=' + encodeURIComponent(person.PrimaryImageTag);
        return Api.base + query;
    }

    function initials(name) {
        var words = String(name || '').split(/\s+/);
        var out = '';
        for (var i = 0; i < words.length && out.length < 2; i++) {
            if (words[i]) out += words[i].charAt(0).toUpperCase();
        }
        return out || '?';
    }

    function personTile(person) {
        var node = U.el('div', 'card person');
        UI.focusable(node, person.Name + (person.Role ? ', ' + person.Role : ''));
        node.setAttribute('role', 'button');
        node.setAttribute('data-key', UI.keyOf('person', person.Id || person.Name));

        var art = U.el('div', 'art');
        var clip = U.el('div', 'art-clip');
        var url = personImageUrl(person);
        if (url) {
            var img = UI.lazyImage(url, person.Name, null);
            img.onerror = function () {
                if (img.parentNode) img.parentNode.removeChild(img);
                clip.appendChild(U.el('span', 'person-initials', initials(person.Name)));
            };
            clip.appendChild(img);
        } else {
            clip.appendChild(U.el('span', 'person-initials', initials(person.Name)));
        }
        art.appendChild(clip);
        node.appendChild(art);
        node.appendChild(U.el('div', 'caption', person.Name || ''));
        if (person.Role) node.appendChild(U.el('div', 'sub', person.Role));
        return node;
    }

    function crewNames(role, people) {
        var names = [];
        (people || []).forEach(function (person) {
            if (person.Type === role && person.Name) names.push(person.Name);
        });
        return names.slice(0, 3).join(', ');
    }

    function fact(label, value) {
        if (!value) return null;
        var node = U.el('div', 'fact');
        node.appendChild(U.el('div', 'fact-label', label));
        node.appendChild(U.el('div', 'fact-value', value));
        return node;
    }

    /* The facts panel is one focus stop, so DOWN reveals it and UP leaves it. */
    function factsBlock(item) {
        var source = sourceOf(item);
        var subtitles = 0;
        if (source) {
            (source.MediaStreams || []).forEach(function (stream) {
                if (stream.Type === 'Subtitle') subtitles++;
            });
        }
        var people = item.People || [];
        var rows = [];
        rows.push(fact('Directed by', crewNames('Director', people)));
        rows.push(fact('Written by', crewNames('Writer', people)));
        if (item.Type === 'Series') {
            rows.push(fact('Status', item.Status));
            rows.push(fact('Seasons', item.ChildCount ? String(item.ChildCount) : ''));
        }
        rows.push(fact('Released', formatDate(item.PremiereDate) ||
            (item.ProductionYear ? String(item.ProductionYear) : '')));
        rows.push(fact('Studio', item.Studios && item.Studios.length ? item.Studios[0].Name : ''));
        rows.push(fact('Video', videoSummary(item)));
        rows.push(fact('Audio', audioSummary(item)));
        rows.push(fact('Subtitles', subtitles ? subtitles + (subtitles === 1 ? ' track' : ' tracks') : ''));
        if (source && source.Container && source.Size) {
            rows.push(fact('File', source.Container.toUpperCase() + ' · ' +
                (source.Size / 1000000000).toFixed(1) + ' GB'));
        }

        var box = U.el('div', 'facts');
        var shown = 0;
        rows.forEach(function (node) { if (node) { box.appendChild(node); shown++; } });
        if (!shown) return null;

        UI.focusable(box, 'Details');
        box.setAttribute('data-key', 'facts');
        box.setAttribute('data-row', 'facts');

        var wrap = U.el('section', 'row facts-wrap');
        wrap.appendChild(U.el('h2', 'row-title', 'Details'));
        wrap.appendChild(box);
        return wrap;
    }

    function toggleButton(item, spec) {
        var btn = UI.button({ label: spec.off, icon: spec.icon, key: spec.key, aria: spec.off });
        function paint() {
            var on = !!item.UserData[spec.field];
            UI.iconize(btn, on ? spec.onIcon || spec.icon : spec.icon, on ? spec.on : spec.off);
            btn.setAttribute('aria-label', (on ? spec.onAria : spec.offAria) + ' ' + (item.Name || ''));
        }
        paint();
        btn.onclick = function () {
            var next = !item.UserData[spec.field];
            spec.request(next).then(function () {
                item.UserData[spec.field] = next;
                if (spec.after) spec.after(next);
                paint();
                U.toast(next ? spec.toastOn : spec.toastOff);
            }, function () {
                /* The server rejected it: leave the state and label as they
                   were rather than claiming a change that will not survive. */
                U.toast('Could not update');
            });
        };
        return btn;
    }

    function hero(item) {
        var node = U.el('section', 'cinema-hero' + (UI.backdropUrl(item, 1600) ? '' : ' bare'));
        node.setAttribute('data-scroll-top', '');

        node.appendChild(UI.titleBlock(item, 'stage-title', 'h1'));
        node.appendChild(UI.metaLine(item, item.Type === 'Series' && item.ChildCount
            ? item.ChildCount + (item.ChildCount === 1 ? ' season' : ' seasons') : ''));
        if (item.Taglines && item.Taglines.length) {
            node.appendChild(U.el('div', 'tagline', item.Taglines[0]));
        }

        item.UserData = item.UserData || {};
        var position = item.UserData.PlaybackPositionTicks;
        var name = item.Name || 'this item';

        var buttons = [];
        buttons.push(UI.button({
            label: position ? 'Resume' : 'Play', icon: 'play', primary: true, key: 'act-play',
            aria: (position ? 'Resume ' : 'Play ') + name,
            onClick: function () { App.playItem(item, { startTicks: position || 0 }); }
        }));
        if (position) {
            buttons.push(UI.button({
                label: 'Start Over', icon: 'rewind', key: 'act-restart', aria: 'Start ' + name + ' over',
                onClick: function () { App.playItem(item, { startTicks: 0 }); }
            }));
        }
        buttons.push(toggleButton(item, {
            key: 'act-watched', field: 'Played', icon: 'eye', onIcon: 'check',
            off: 'Mark Watched', on: 'Watched',
            offAria: 'Mark as watched:', onAria: 'Mark as unwatched:',
            toastOn: 'Marked as watched', toastOff: 'Marked as unwatched',
            request: function (next) {
                return next ? Api.markPlayed(item.Id) : Api.markUnplayed(item.Id);
            },
            after: function (next) { if (next) item.UserData.PlaybackPositionTicks = 0; }
        }));
        buttons.push(toggleButton(item, {
            key: 'act-fav', field: 'IsFavorite', icon: 'star',
            off: 'Favorite', on: 'Favorited',
            offAria: 'Add to favorites:', onAria: 'Remove from favorites:',
            toastOn: 'Added to favorites', toastOff: 'Removed from favorites',
            request: function (next) { return Api.setFavorite(item.Id, next); }
        }));
        node.appendChild(UI.buttonRow(buttons));

        if (position && item.RunTimeTicks) {
            var line = U.el('div', 'progress-line');
            var track = U.el('div', 'track');
            var fill = document.createElement('i');
            fill.style.width = Math.min(100, Math.max(2, position / item.RunTimeTicks * 100)) + '%';
            track.appendChild(fill);
            line.appendChild(track);
            line.appendChild(U.el('span', '', U.fmtRuntime(item.RunTimeTicks - position) + ' left'));
            node.appendChild(line);
        }

        if (item.Overview) node.appendChild(U.el('p', 'overview', item.Overview));
        return node;
    }

    function castShelf(item) {
        var cast = [];
        var people = item.People || [];
        for (var i = 0; i < people.length && cast.length < 16; i++) {
            if (people[i].Type === 'Actor' && people[i].Name) cast.push(personTile(people[i]));
        }
        return UI.shelf('Cast', cast, { key: 'cast', className: 'people' });
    }

    /* Series: a season picker and one episode shelf that follows it. The
       overview of the focused episode sits under the shelf. */
    function seriesBlock(shell, series, host) {
        var bar = U.el('div', 'season-bar');
        bar.setAttribute('data-row', 'seasons');
        var shelfHost = U.el('div', 'episodes-host');
        var overview = U.el('p', 'ep-overview');
        overview.setAttribute('aria-live', 'polite');
        host.appendChild(bar);
        host.appendChild(shelfHost);
        host.appendChild(overview);

        shell.screen.addEventListener('focus', function (event) {
            var node = event.target;
            if (node && node._item && node._item.Type === 'Episode') {
                overview.textContent = node._item.Overview || '';
            }
        }, true);

        var seasons = [];
        var token = 0;

        function showSeason(index) {
            token++;
            var mine = token;
            var buttons = bar.childNodes;
            for (var i = 0; i < buttons.length; i++) {
                buttons[i].className = 'btn' + (i === index ? ' on' : '');
            }
            U.clear(shelfHost);
            overview.textContent = '';
            Api.episodes(series.Id, seasons[index].Id).then(function (episodes) {
                if (mine !== token) return;
                var nodes = episodes.slice(0, 60).map(function (episode) {
                    var tag = UI.episodeTag(episode);
                    var runtime = episode.RunTimeTicks ? U.fmtRuntime(episode.RunTimeTicks) : '';
                    return UI.card(episode, {
                        landscape: true, keyPrefix: 'ep',
                        caption: episode.Name || 'Episode',
                        sub: [tag, runtime].join('  \u00b7  ').replace(/^  \u00b7  |  \u00b7  $/g, ''),
                        onClick: function (ep) {
                            App.playItem(ep, {
                                startTicks: (ep.UserData && ep.UserData.PlaybackPositionTicks) || 0
                            });
                        }
                    });
                });
                var shelf = UI.shelf('Episodes', nodes, { key: 'episodes' });
                if (shelf) {
                    shelfHost.appendChild(shelf);
                    U.lazy.check();
                    /* Start on the first unfinished episode. */
                    var next = 0;
                    for (var n = 0; n < episodes.length; n++) {
                        if (!(episodes[n].UserData && episodes[n].UserData.Played)) { next = n; break; }
                    }
                    var cards = shelf.querySelectorAll('.card');
                    if (cards[next] && cards[next]._item) overview.textContent = cards[next]._item.Overview || '';
                } else {
                    shelfHost.appendChild(UI.empty('No episodes in this season.'));
                }
            }).catch(function (err) {
                if (mine === token) shelfHost.appendChild(
                    UI.empty('Could not load episodes: ' + (err.message || 'unknown')));
            });
        }

        Api.seasons(series.Id).then(function (result) {
            seasons = result || [];
            if (!seasons.length) { host.appendChild(UI.empty('No episodes found.')); return; }
            seasons.forEach(function (season, index) {
                var btn = UI.button({
                    label: season.Name || ('Season ' + (index + 1)),
                    key: 'season-' + index,
                    onClick: function () { showSeason(index); }
                });
                bar.appendChild(btn);
            });
            /* Start on the first real season, not on the specials that Jellyfin
               lists first. */
            var start = 0;
            for (var s = 0; s < seasons.length; s++) {
                if ((seasons[s].IndexNumber || 0) > 0) { start = s; break; }
            }
            showSeason(start);
        }).catch(function () {
            host.appendChild(UI.empty('Could not load seasons.'));
        });
    }

    function paint(shell, item) {
        U.clear(shell.scroll);
        if (shell.backdrop) shell.backdrop.set(UI.backdropUrl(item, 1600));

        shell.scroll.appendChild(hero(item));

        var body = U.el('div', 'cinema-body');
        shell.scroll.appendChild(body);

        if (item.Type === 'Series') {
            var host = U.el('section', 'series-block');
            body.appendChild(host);
            seriesBlock(shell, item, host);
        }

        var cast = castShelf(item);
        if (cast) body.appendChild(cast);
        var facts = factsBlock(item);
        if (facts) body.appendChild(facts);

        var similarHost = U.el('div', '');
        body.appendChild(similarHost);
        body.appendChild(U.el('div', 'shelf-end'));

        U.lazy.check();
        U.focusFirst(shell.screen);

        if (item.Type === 'Movie' || item.Type === 'Series') {
            Api.similar(item.Id, 12).then(function (items) {
                var row = UI.row('More Like This', items, {
                    keyPrefix: 'similar',
                    onClick: function (other) { App.go('detail', { itemId: other.Id, item: other }); }
                });
                if (row) { similarHost.appendChild(row); U.lazy.check(); }
            }).catch(function () { /* an empty shelf beats an error */ });
        }
    }

    window.Screens.detail = {
        render: function (container, params) {
            var shell = UI.screenShell({ backdrop: true, className: 'deep cinema' });
            container.appendChild(shell.screen);
            shell.scroll.appendChild(UI.spinner());

            var itemId = params.itemId || (params.item && params.item.Id);

            function done(item) {
                paint(shell, item);
                U.focusFirst(container);
            }

            /* Cards handed over by a list carry no cast or streams, so the full
               record is loaded unless it already came with people. */
            if (params.item && params.item.People && params.item.People.length) {
                done(params.item);
                return;
            }

            Api.item(itemId).then(done).catch(function (err) {
                U.clear(shell.scroll);
                shell.scroll.appendChild(UI.empty('Could not load this item: ' + (err.message || 'unknown')));
                shell.scroll.appendChild(UI.buttonRow([UI.button({
                    label: 'Back', icon: 'back', primary: true, onClick: function () { App.back(); }
                })], { className: 'pad' }));
                U.focusFirst(container);
            });
        },

        destroy: function () {}
    };
})(window);
