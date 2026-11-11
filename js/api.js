/* Jellyfin REST client.
   Only the endpoints this client actually needs, plus the WebSocket. */
(function (global) {
    'use strict';

    var CLIENT_NAME = 'JellyLean';
    /* Must equal the widget version in config.xml; scripts/build.sh fails the
       build when they differ. */
    var CLIENT_VERSION = '1.0.10';

    /* What the browse screens need to draw a card and the Home stage: art for
       every role (backdrop and logo feed the ambient stage) and the text that
       goes with it. */
    var LIST_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,Overview,Genres,' +
        'OfficialRating,CommunityRating,ChildCount';
    var LIST_IMAGES = 'Primary,Backdrop,Thumb,Logo';

    var state = {
        base: '',
        token: '',
        userId: '',
        deviceId: '',
        deviceName: 'Samsung TV'
    };

    /* One session-level hook: a 401 anywhere means the stored token is dead.
       The app clears it and returns to setup instead of leaving every screen
       showing "HTTP 401" until the viewer finds Sign Out. */
    var unauthorizedHandler = null;
    var unauthorizedNotified = false;
    var REQUEST_TIMEOUT_MS = 20000;

    function notifyUnauthorized() {
        if (!state.token || unauthorizedNotified) return;
        unauthorizedNotified = true;
        if (unauthorizedHandler) {
            try { unauthorizedHandler(); } catch (e) { console.error('unauthorized handler', e); }
        }
    }

    function failure(status, text) {
        var err = parseError(status, text);
        if (status === 401) notifyUnauthorized();
        return err;
    }

    /* ------------------------------------------------------------- helpers */

    function s_trim(value) {
        return String(value === undefined || value === null ? '' : value)
            .replace(/^\s+/, '').replace(/\s+$/, '');
    }

    function normalizeServerUrl(url) {
        var value = String(url || '').trim();
        if (!value) return '';
        if (!/^https?:\/\//i.test(value)) value = 'http://' + value;
        return value.replace(/\/+$/, '');
    }

    function queryString(params) {
        var parts = [];
        for (var key in params) {
            if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
            var value = params[key];
            if (value === undefined || value === null || value === '') continue;
            /* Jellyfin binds repeated keys to arrays; a comma-joined string is
               rejected by 12.x validators ("is not a valid value"). */
            if (Object.prototype.toString.call(value) === '[object Array]') {
                for (var i = 0; i < value.length; i++) {
                    if (value[i] === undefined || value[i] === null || value[i] === '') continue;
                    parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value[i]));
                }
                continue;
            }
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(value));
        }
        return parts.join('&');
    }

    function ApiError(status, message, payload) {
        this.name = 'ApiError';
        this.status = status;
        this.message = message || ('HTTP ' + status);
        this.payload = payload;
    }
    ApiError.prototype = Object.create(Error.prototype);
    ApiError.prototype.constructor = ApiError;

    function authHeader() {
        return 'MediaBrowser Client="' + CLIENT_NAME + '", Device="' + state.deviceName +
            '", DeviceId="' + state.deviceId + '", Version="' + CLIENT_VERSION + '"';
    }

    function authHeaderWithToken() {
        var header = authHeader();
        if (state.token) header += ', Token="' + state.token + '"';
        return header;
    }

    function buildHeaders(hasBody) {
        /* Servers up to 10.x accept the legacy X-Emby-Authorization / X-Emby-Token
           pair; 12.x dropped it and only honours Authorization. Sending the
           canonical form with the legacy pair as a fallback covers both. */
        var headers = {
            'Accept': 'application/json',
            'Authorization': authHeaderWithToken(),
            'X-Emby-Authorization': authHeader()
        };
        if (state.token) headers['X-Emby-Token'] = state.token;
        if (hasBody) headers['Content-Type'] = 'application/json';
        return headers;
    }

    function url(path, params) {
        var qs = params ? queryString(params) : '';
        return state.base + path + (qs ? '?' + qs : '');
    }

    function parseError(status, text) {
        try {
            var parsed = JSON.parse(text);
            return new ApiError(status, parsed.Message || parsed.message || ('HTTP ' + status), parsed);
        } catch (e) {
            return new ApiError(status, text ? String(text).slice(0, 200) : ('HTTP ' + status));
        }
    }

    function request(method, path, body, params) {
        var target = url(path, params);
        var payload = (body === undefined || body === null) ? null : JSON.stringify(body);

        if (!global.fetch) {
            return xhrRequest(method, target, payload);
        }

        /* A TV on Wi-Fi can reach a server that never answers; without a
           timeout the promise never settles and the awaiting screen stays
           blank forever. The XHR fallback already had this. */
        var controller = global.AbortController ? new global.AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT_MS) : null;
        function settle() { if (timer) { clearTimeout(timer); timer = null; } }

        return fetch(target, {
            method: method,
            headers: buildHeaders(payload !== null),
            body: payload,
            cache: 'no-store',
            signal: controller ? controller.signal : undefined
        }).then(function (response) {
            return response.text().then(function (text) {
                if (!response.ok) throw failure(response.status, text);
                if (!text) return null;
                try { return JSON.parse(text); } catch (e) { return text; }
            });
        }).then(function (result) {
            settle();
            return result;
        }, function (error) {
            settle();
            if (controller && error && error.name === 'AbortError') {
                throw new ApiError(0, 'The server did not respond');
            }
            throw error;
        });
    }

    /* Old Tizen builds occasionally ship a stub fetch; XHR is the safety net. */
    function xhrRequest(method, target, payload) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open(method, target, true);
            var headers = buildHeaders(payload !== null);
            for (var key in headers) {
                if (Object.prototype.hasOwnProperty.call(headers, key)) {
                    xhr.setRequestHeader(key, headers[key]);
                }
            }
            xhr.timeout = 20000;
            xhr.onload = function () {
                if (xhr.status < 200 || xhr.status >= 300) {
                    reject(failure(xhr.status, xhr.responseText));
                    return;
                }
                if (!xhr.responseText) { resolve(null); return; }
                try { resolve(JSON.parse(xhr.responseText)); } catch (e) { resolve(xhr.responseText); }
            };
            xhr.onerror = function () { reject(new ApiError(0, 'Network error')); };
            xhr.ontimeout = function () { reject(new ApiError(0, 'Request timed out')); };
            xhr.send(payload);
        });
    }

    /* ------------------------------------------------------- device profile
       Describes what a 2017 Samsung TV can actually decode, so the server only
       transcodes what it must. `forceTranscode` flips every source to HLS. */

    /* No practical bitrate ceiling. Jellyfin used to pick the transcode
       resolution from this number, so the resolution is now pinned separately
       (MAX_WIDTH x MAX_HEIGHT, below) and the bitrate is left effectively
       unlimited. */
    var UNCAPPED_BITRATE = 1000000000;
    var MAX_WIDTH = 1920;
    var MAX_HEIGHT = 1080;

    /* The viewer's cap in Mbps (0 = none) as the bits per second Jellyfin wants. */
    function bitrateCap(maxMbps) {
        var mbps = Number(maxMbps);
        if (!isFinite(mbps) || mbps <= 0) return UNCAPPED_BITRATE;
        return Math.round(mbps * 1000000);
    }

    /* `features` carries the two things the viewer can change in Settings:
         surround  true (default) keeps up to 5.1 channels, false downmixes to
                   stereo AAC whenever the server has to touch the audio;
         hevc      true also claims HEVC for direct play (off by default, see
                   the note on VIDEO_DIRECT below). */
    function deviceProfile(forceTranscode, maxMbps, features) {
        var cap = bitrateCap(maxMbps);
        var opts = features || {};
        var surround = opts.surround !== false;
        var hevc = opts.hevc === true;

        /* Only codecs a 2017 Samsung actually decodes. Claiming more (DTS,
           TrueHD, Opus, Vorbis, FLAC) makes the server hand over a stream
           this TV then plays as silence or a black screen.
           HEVC is absent unless the viewer turns it on: a UHD remux
           direct-played here gave audio with a black picture, which looks like
           a client bug. By default the server transcodes it to H.264, since a
           1080p panel gains nothing from HEVC. */
        var VIDEO_DIRECT = hevc ? 'h264,mpeg4,hevc,h265' : 'h264,mpeg4';
        var TS_VIDEO_DIRECT = hevc ? 'h264,mpeg2video,hevc,h265' : 'h264,mpeg2video';
        var AUDIO_DIRECT = 'aac,mp3,ac3,eac3';

        var videoConditions = [
            { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '41', IsRequired: false },
            { Condition: 'LessThanEqual', Property: 'Width', Value: String(MAX_WIDTH), IsRequired: true },
            { Condition: 'LessThanEqual', Property: 'Height', Value: String(MAX_HEIGHT), IsRequired: true },
            { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }
        ];

        var codecProfiles = [
            { Type: 'Video', Codec: 'h264', Conditions: videoConditions }
        ];
        if (hevc) {
            /* HEVC levels are 30 x the spec number, so 4.1 is 123. */
            codecProfiles.push({
                Type: 'Video', Codec: 'hevc,h265',
                Conditions: [
                    { Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '123', IsRequired: false },
                    { Condition: 'LessThanEqual', Property: 'Width', Value: String(MAX_WIDTH), IsRequired: true },
                    { Condition: 'LessThanEqual', Property: 'Height', Value: String(MAX_HEIGHT), IsRequired: true },
                    { Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '10', IsRequired: false }
                ]
            });
        }
        if (surround) {
            /* AC3 tops out at 5.1 and so does what this TV hands to an ARC
               receiver. A 7.1 E-AC3 or AAC track must be re-encoded rather
               than direct played into a decoder that may drop it. */
            codecProfiles.push({
                Type: 'VideoAudio', Codec: AUDIO_DIRECT,
                Conditions: [
                    { Condition: 'LessThanEqual', Property: 'AudioChannels', Value: '6', IsRequired: true }
                ]
            });
        }

        var profile = {
            Name: 'JellyLean (Samsung Tizen)',
            MaxStreamingBitrate: cap,
            MaxStaticBitrate: cap,
            DirectPlayProfiles: [
                { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: VIDEO_DIRECT, AudioCodec: AUDIO_DIRECT },
                { Container: 'mkv', Type: 'Video', VideoCodec: VIDEO_DIRECT, AudioCodec: AUDIO_DIRECT },
                { Container: 'ts,mpegts', Type: 'Video', VideoCodec: TS_VIDEO_DIRECT, AudioCodec: AUDIO_DIRECT },
                { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3' },
                { Container: 'aac', Type: 'Audio', AudioCodec: 'aac' },
                { Container: 'flac', Type: 'Audio', AudioCodec: 'flac' },
                { Container: 'm4a', Type: 'Audio', AudioCodec: 'aac,alac' }
            ],
            TranscodingProfiles: [
                {
                    /* Surround lists ac3 first so a 5.1 source keeps its
                       channels when only the video needs transcoding, and
                       DTS/TrueHD become 5.1 AC3 instead of stereo AAC. AAC
                       stays in the list as the fallback the server can
                       always produce. Stereo mode asks for AAC alone. */
                    Container: 'ts', Type: 'Video', VideoCodec: 'h264',
                    AudioCodec: surround ? 'ac3,eac3,aac' : 'aac',
                    Protocol: 'hls', Context: 'Streaming',
                    MaxAudioChannels: surround ? '6' : '2',
                    MinSegments: 1, BreakOnNonKeyFrames: true
                },
                { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Protocol: 'http', Context: 'Streaming' }
            ],
            CodecProfiles: codecProfiles,
            ContainerProfiles: [],
            ResponseProfiles: [
                { Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' },
                { Type: 'Video', Container: 'mov', MimeType: 'video/mp4' }
            ],
            SubtitleProfiles: [
                /* Every text format is served as WebVTT and drawn by
                   js/subtitles.js, so the transcoder never has to rasterise
                   them. Image formats are declared as Encode: the server can
                   only make PGS/DVD visible by burning it into the picture. */
                { Format: 'srt', Method: 'External' },
                { Format: 'subrip', Method: 'External' },
                { Format: 'ass', Method: 'External' },
                { Format: 'ssa', Method: 'External' },
                { Format: 'ttml', Method: 'External' },
                { Format: 'mov_text', Method: 'External' },
                { Format: 'vtt', Method: 'External' },
                { Format: 'webvtt', Method: 'External' },
                { Format: 'pgssub', Method: 'Encode' },
                { Format: 'pgs', Method: 'Encode' },
                { Format: 'dvdsub', Method: 'Encode' },
                { Format: 'dvbsub', Method: 'Encode' }
            ]
        };

        if (forceTranscode) {
            profile.DirectPlayProfiles = [];
        }
        return profile;
    }

    /* ----------------------------------------------------------------- API */

    var Api = {
        Error: ApiError,

        /* Exposed so test/profile.js can pin what the TV claims to decode. */
        deviceProfile: deviceProfile,

        /* The version in config.xml, so Settings and the media header cannot drift. */
        version: CLIENT_VERSION,

        configure: function (config) {
            state.base = normalizeServerUrl(config.serverUrl || '');
            state.token = config.token || '';
            state.userId = config.userId || '';
            state.deviceId = config.deviceId || '';
            state.deviceName = config.deviceName || 'Samsung TV';
            unauthorizedNotified = false;
        },

        onUnauthorized: function (handler) {
            unauthorizedHandler = handler;
        },

        /* Plugin routes authenticate with the same Jellyfin token, but they do
           not travel through `request`, so they report a 401 here. */
        notifyUnauthorized: notifyUnauthorized,

        normalizeServerUrl: normalizeServerUrl,

        /* True for plain http:// to anything that is not a private-network or
           .local host, i.e. credentials would cross the open internet unencrypted. */
        isInsecureRemote: function (serverUrl) {
            var value = normalizeServerUrl(serverUrl);
            if (!/^http:\/\//i.test(value)) return false;
            var host = value.replace(/^http:\/\//i, '').split(/[\/?#]/)[0]
                .replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase();
            if (host === 'localhost' || /\.(local|lan|home|internal)$/.test(host)) return false;
            if (!/\./.test(host)) return false; /* bare hostname: LAN name */
            var m = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
            if (!m) return true;
            var a = +m[1], b = +m[2];
            return !(a === 10 || a === 127 || (a === 192 && b === 168) ||
                (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254));
        },

        get base() { return state.base; },
        get token() { return state.token; },
        get userId() { return state.userId; },

        headers: buildHeaders,

        publicInfo: function (serverUrl) {
            var target = normalizeServerUrl(serverUrl);
            return fetch(target + '/System/Info/Public', {
                headers: {
                    'Accept': 'application/json',
                    'X-Emby-Authorization': authHeader()
                }
            }).then(function (r) {
                return r.text().then(function (text) {
                    if (!r.ok) throw parseError(r.status, text);
                    return JSON.parse(text);
                });
            });
        },

        /* ------------------------------------------------------------ auth */

        authenticate: function (username, password) {
            return request('POST', '/Users/AuthenticateByName', {
                Username: username,
                Pw: password
            }).then(function (result) {
                return {
                    serverUrl: state.base,
                    token: result.AccessToken,
                    userId: result.User.Id,
                    userName: result.User.Name,
                    serverId: result.ServerId
                };
            });
        },

        quickConnectEnabled: function () {
            return request('GET', '/QuickConnect/Enabled').then(function (enabled) {
                return enabled === true;
            }).catch(function () { return false; });
        },

        quickConnectInitiate: function () {
            return request('POST', '/QuickConnect/Initiate');
        },

        quickConnectPoll: function (secret) {
            return request('GET', '/QuickConnect/Connect', null, { secret: secret });
        },

        quickConnectAuthenticate: function (secret) {
            return request('POST', '/Users/AuthenticateWithQuickConnect', { Secret: secret })
                .then(function (result) {
                    return {
                        serverUrl: state.base,
                        token: result.AccessToken,
                        userId: result.User.Id,
                        userName: result.User.Name,
                        serverId: result.ServerId
                    };
                });
        },

        currentUser: function () {
            return request('GET', '/Users/Me');
        },

        /* Approve a Quick Connect code with this device's own Jellyfin login.
           Used to sign in to Seerr without typing anything. */
        quickConnectAuthorize: function (code) {
            return request('POST', '/QuickConnect/Authorize', null, { code: code });
        },

        logout: function () {
            return request('POST', '/Sessions/Logout').catch(function () { /* token may already be gone */ });
        },

        /* ------------------------------------------------------------ browse */

        views: function () {
            return request('GET', '/Users/' + state.userId + '/Views')
                .then(function (result) { return (result && result.Items) || []; });
        },

        resume: function (limit) {
            return request('GET', '/Users/' + state.userId + '/Items/Resume', null, {
                Limit: limit || 12,
                MediaTypes: 'Video',
                Fields: LIST_FIELDS,
                ImageTypeLimit: 1,
                EnableImageTypes: LIST_IMAGES,
                EnableTotalRecordCount: false
            }).then(function (result) { return (result && result.Items) || []; });
        },

        latest: function (parentId, limit) {
            return request('GET', '/Users/' + state.userId + '/Items/Latest', null, {
                ParentId: parentId,
                Limit: limit || 14,
                Fields: LIST_FIELDS,
                ImageTypeLimit: 1,
                EnableImageTypes: LIST_IMAGES,
                GroupItems: false
            }).then(function (result) { return result || []; });
        },

        items: function (options) {
            var opts = options || {};
            return request('GET', '/Users/' + state.userId + '/Items', null, {
                ParentId: opts.parentId,
                Recursive: opts.recursive === false ? false : true,
                IncludeItemTypes: opts.includeItemTypes,
                ExcludeItemTypes: opts.excludeItemTypes,
                SortBy: opts.sortBy || 'SortName',
                SortOrder: opts.sortOrder || 'Ascending',
                StartIndex: opts.startIndex || 0,
                Limit: opts.limit || 100,
                SearchTerm: opts.searchTerm,
                Fields: LIST_FIELDS,
                ImageTypeLimit: 1,
                EnableImageTypes: LIST_IMAGES,
                EnableTotalRecordCount: true
            });
        },

        item: function (itemId) {
            return request('GET', '/Users/' + state.userId + '/Items/' + itemId);
        },

        seasons: function (seriesId) {
            return request('GET', '/Shows/' + seriesId + '/Seasons', null, {
                UserId: state.userId,
                Fields: 'PrimaryImageAspectRatio',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary'
            }).then(function (result) { return (result && result.Items) || []; });
        },

        episodes: function (seriesId, seasonId) {
            return request('GET', '/Shows/' + seriesId + '/Episodes', null, {
                UserId: state.userId,
                SeasonId: seasonId,
                Fields: 'Overview,PrimaryImageAspectRatio,ProductionYear',
                ImageTypeLimit: 1,
                EnableImageTypes: 'Primary'
            }).then(function (result) {
                var items = (result && result.Items) || [];
                /* Jellyfin 12.4 sometimes ignores SeasonId and returns the whole
                   series (Chernobyl: 17 episodes for a 5-episode season), so keep
                   only the season that was asked for.
                   shortcut: an item without SeasonId is kept, revisit if a server
                   omits it. */
                if (!seasonId) return items;
                return items.filter(function (ep) {
                    return !ep.SeasonId || ep.SeasonId === seasonId;
                });
            });
        },

        nextUp: function (seriesId) {
            return request('GET', '/Shows/NextUp', null, {
                UserId: state.userId,
                SeriesId: seriesId,
                Limit: 1,
                Fields: 'PrimaryImageAspectRatio,ProductionYear'
            }).then(function (result) {
                return result && result.Items && result.Items.length ? result.Items[0] : null;
            });
        },

        /* Home's "Next Up" row: the next unwatched episode of every show the
           viewer has started. */
        nextUpList: function (limit) {
            return request('GET', '/Shows/NextUp', null, {
                UserId: state.userId,
                Limit: limit || 14,
                Fields: LIST_FIELDS,
                ImageTypeLimit: 1,
                EnableImageTypes: LIST_IMAGES
            }).then(function (result) { return (result && result.Items) || []; });
        },

        similar: function (itemId, limit) {
            return request('GET', '/Items/' + itemId + '/Similar', null, {
                UserId: state.userId,
                Limit: limit || 12,
                Fields: LIST_FIELDS,
                ImageTypeLimit: 1,
                EnableImageTypes: LIST_IMAGES
            }).then(function (result) { return (result && result.Items) || []; });
        },

        /* ---------------------------------------------------------- playback */

        playbackInfo: function (itemId, options) {
            var opts = options || {};
            var forceTranscode = !!opts.forceTranscode;
            var params = { UserId: state.userId };
            var body = {
                UserId: state.userId,
                StartTimeTicks: opts.startTicks || 0,
                IsPlayback: true,
                AutoOpenLiveStream: true,
                MaxStreamingBitrate: bitrateCap(opts.maxBitrate),
                EnableDirectPlay: !forceTranscode,
                EnableDirectStream: !forceTranscode,
                EnableTranscoding: true,
                DeviceProfile: deviceProfile(forceTranscode, opts.maxBitrate, {
                    surround: opts.surround,
                    hevc: opts.hevc
                })
            };

            /* Jellyfin only honours SubtitleStreamIndex when the source is
               named explicitly. Without MediaSourceId the response falls back
               to the user's default track, which is not what was picked. */
            if (opts.mediaSourceId) body.MediaSourceId = opts.mediaSourceId;
            if (opts.subtitleIndex !== undefined && opts.subtitleIndex !== null &&
                    opts.subtitleIndex >= 0) {
                body.SubtitleStreamIndex = opts.subtitleIndex;
            }
            if (opts.audioIndex !== undefined && opts.audioIndex !== null &&
                    opts.audioIndex >= 0) {
                body.AudioStreamIndex = opts.audioIndex;
            }

            return request('POST', '/Items/' + itemId + '/PlaybackInfo', body, params);
        },

        /* A 2017 TV is 1080p. Unless the viewer sets a cap in Settings
           (opts.maxBitrate, Mbps) the transcode bitrate is uncapped, so the target
           resolution can no longer be inferred from it: the device profile
           requires Width/Height <= 1920x1080 and the transcoding URL is pinned
           to maxWidth=1920&maxHeight=1080 (Api.limitResolution) so the server
           never targets a resolution this panel refuses (audio plays, picture
           stays black). */
        negotiate: function (itemId, options) {
            var opts = options || {};
            var forceTranscode = !!opts.forceTranscode;
            var subtitleIndex = (opts.subtitleIndex === undefined || opts.subtitleIndex === null)
                ? -1 : opts.subtitleIndex;
            var audioIndex = (opts.audioIndex === undefined || opts.audioIndex === null)
                ? -1 : opts.audioIndex;

            function request() {
                return Api.playbackInfo(itemId, {
                    startTicks: opts.startTicks || 0,
                    forceTranscode: forceTranscode,
                    maxBitrate: opts.maxBitrate,
                    surround: opts.surround,
                    hevc: opts.hevc,
                    mediaSourceId: opts.mediaSourceId,
                    subtitleIndex: subtitleIndex,
                    audioIndex: audioIndex
                });
            }

            function build(info, source) {
                if (!source) {
                    return { info: info, source: null, method: 'DirectPlay', url: '', playSessionId: '' };
                }

                var playSessionId = (info && info.PlaySessionId) || '';
                var method;
                var streamUrl;

                if (source.SupportsDirectPlay === true) {
                    method = 'DirectPlay';
                    streamUrl = Api.streamUrl(itemId, source.Id, playSessionId);
                } else if (source.SupportsDirectStream && source.DirectStreamUrl) {
                    method = 'DirectStream';
                    streamUrl = Api.absoluteUrl(source.DirectStreamUrl);
                } else if (source.TranscodingUrl) {
                    method = 'Transcode';
                    /* Without a requested track the server may pre-select the
                       file's default subtitle and burn it in. That is wasted
                       work: text tracks are drawn by js/subtitles.js, and the
                       client wants no image burn-in unless asked. Dropping the
                       parameters is what jellyfin-web does when no subtitle is
                       being encoded. When an image track was requested, keep
                       its SubtitleStreamIndex/SubtitleMethod=Encode pair. */
                    streamUrl = Api.absoluteUrl(Api.limitResolution(subtitleIndex >= 0
                        ? source.TranscodingUrl
                        : Api.stripSubtitleParams(source.TranscodingUrl)));
                } else {
                    method = 'DirectPlay';
                    streamUrl = Api.streamUrl(itemId, source.Id, playSessionId);
                }

                return { info: info, source: source, method: method, url: streamUrl, playSessionId: playSessionId };
            }

            return request().then(function (info) {
                var sources = (info && info.MediaSources) || [];
                return build(info, Api.pickSource(sources));
            });
        },

        pickSource: function (sources) {
            var list = sources || [];
            for (var i = 0; i < list.length; i++) {
                if (list[i].SupportsDirectPlay === true) return list[i];
            }
            for (var j = 0; j < list.length; j++) {
                if (list[j].SupportsDirectStream === true) return list[j];
            }
            return list[0];
        },

        canDirectPlay: function (source) {
            if (!source) return false;
            if (source.SupportsDirectPlay === true) return true;
            return !!(source.SupportsDirectStream && source.DirectStreamUrl);
        },

        imageUrl: function (item, type, maxWidth, maxHeight) {
            if (!item || !item.Id) return '';
            var tag = item.ImageTags && item.ImageTags[type];
            if (!tag && type === 'Backdrop' && item.BackdropImageTags && item.BackdropImageTags.length) {
                tag = item.BackdropImageTags[0];
            }
            return Api.imageById(item.Id, type, maxWidth, tag, maxHeight);
        },

        /* Artwork that belongs to another item: an episode borrows its series'
           backdrop and logo. */
        imageById: function (itemId, type, maxWidth, tag, maxHeight) {
            if (!itemId) return '';
            var params = {
                maxWidth: maxWidth || 400,
                quality: 84,
                api_key: state.token
            };
            /* Both caps keep the server from upscaling into a box the client
               cannot use (a logo taller than the title row, for instance). */
            if (maxHeight) params.maxHeight = maxHeight;
            if (tag) params.tag = tag;
            return url('/Items/' + itemId + '/Images/' + type, params);
        },

        subtitleUrl: function (itemId, mediaSourceId, streamIndex) {
            return url('/Videos/' + itemId + '/' + mediaSourceId + '/Subtitles/' + streamIndex + '/Stream.vtt', {
                api_key: state.token
            });
        },

        streamUrl: function (itemId, mediaSourceId, playSessionId) {
            return url('/Videos/' + itemId + '/stream', {
                static: 'true',
                mediaSourceId: mediaSourceId,
                playSessionId: playSessionId,
                api_key: state.token,
                DeviceId: state.deviceId
            });
        },

        /* Read the resolution and bitrate the server actually targets for a
           transcoded stream. The master playlist is cheap to fetch (no encoder
           work until a segment is requested) and it is the only place the
           negotiated output is stated. Never rejects: a diagnostics request
           must not be able to break playback. */
        transcodeOutput: function (absoluteUrl) {
            return new Promise(function (resolve) {
                if (!absoluteUrl) { resolve(null); return; }

                var xhr = new XMLHttpRequest();
                xhr.open('GET', absoluteUrl, true);
                xhr.timeout = 10000;

                xhr.onload = function () {
                    if (xhr.status < 200 || xhr.status >= 300) { resolve(null); return; }

                    var lines = (xhr.responseText || '').split('\n');
                    var stream = '';

                    for (var i = 0; i < lines.length; i++) {
                        if (lines[i].indexOf('#EXT-X-STREAM-INF') === 0) { stream = lines[i]; break; }
                    }

                    var res = /RESOLUTION=(\d+x\d+)/.exec(stream);
                    var bw = /BANDWIDTH=(\d+)/.exec(stream);

                    resolve({
                        resolution: res ? res[1] : '',
                        bitrate: bw ? Math.round(Number(bw[1]) / 100000) / 10 : 0
                    });
                };

                xhr.onerror = function () { resolve(null); };
                xhr.ontimeout = function () { resolve(null); };
                xhr.send();
            });
        },

        /* A cold transcode has nothing on disk yet: ffmpeg probes the source,
           then encodes, and only then does the first segment appear. On this
           library that took 15 s for a 37 Mbps TrueHD remux, and Samsung's HLS
           engine gives up after roughly 20 s without data — which looks exactly
           like a broken stream even though the server is working fine.
           Asking for that first segment ourselves holds our own connection for
           as long as the server needs, and returns the moment the file exists,
           so AVPlay's first request is answered immediately. Never rejects: a
           slow transcode must not be able to stop playback. */
        warmTranscode: function (absoluteUrl, options) {
            var opts = options || {};
            var segmentWait = opts.segmentWait || 90000;
            var started = Date.now();
            var report = { warm: false, ms: 0, segments: 0 };

            function fetchText(target, timeout) {
                return new Promise(function (resolve) {
                    if (!target) { resolve(''); return; }
                    var xhr = new XMLHttpRequest();
                    xhr.open('GET', target, true);
                    xhr.timeout = timeout;
                    xhr.onload = function () {
                        resolve((xhr.status >= 200 && xhr.status < 300) ? (xhr.responseText || '') : '');
                    };
                    xhr.onerror = function () { resolve(''); };
                    xhr.ontimeout = function () { resolve(''); };
                    xhr.send();
                });
            }

            function directoryOf(target) {
                var split = target.indexOf('?');
                var path = split === -1 ? target : target.slice(0, split);
                return path.slice(0, path.lastIndexOf('/') + 1);
            }

            function entries(text, needle) {
                var lines = String(text || '').split('\n');
                var found = [];
                for (var i = 0; i < lines.length; i++) {
                    var line = s_trim(lines[i]);
                    if (!line || line.charAt(0) === '#') continue;
                    if (line.indexOf(needle) === -1) continue;
                    found.push(line);
                }
                return found;
            }

            function finish(warm) {
                report.warm = warm;
                report.ms = Date.now() - started;
                return report;
            }

            var base = directoryOf(absoluteUrl);

            return fetchText(absoluteUrl, 20000).then(function (master) {
                var variants = entries(master, '.m3u8');
                if (!variants.length) return finish(false);

                return fetchText(base + variants[0], 30000).then(function (media) {
                    var segments = entries(media, '.ts');
                    if (!segments.length) return finish(false);

                    return fetchText(base + segments[0], segmentWait).then(function (first) {
                        if (!first) return finish(false);
                        report.segments = 1;

                        /* A second segment gives AVPlay something to buffer
                           while the encoder catches up, but only if the server
                           already wrote it. */
                        return fetchText(base + variants[0], 20000).then(function (fresh) {
                            var later = entries(fresh, '.ts');
                            var next = later.length > 1 ? later[1] : '';
                            if (!next || next === segments[0]) return finish(true);
                            return fetchText(base + next, 60000).then(function (second) {
                                if (second) report.segments = 2;
                                return finish(true);
                            });
                        });
                    });
                });
            }).then(null, function () { return finish(false); });
        },

        /* Pin a transcoding URL to 1920x1080 at most, whatever the server chose.
           Replaces any maxWidth/maxHeight already present and drops the
           width/height pair that would override them. */
        limitResolution: function (pathOrUrl) {
            if (!pathOrUrl) return '';

            var split = pathOrUrl.indexOf('?');
            var base = split === -1 ? pathOrUrl : pathOrUrl.slice(0, split);
            var parts = split === -1 ? [] : pathOrUrl.slice(split + 1).split('&');
            var kept = [];

            for (var i = 0; i < parts.length; i++) {
                if (!parts[i]) continue;
                if (/^(maxWidth|maxHeight|width|height)=/i.test(parts[i])) continue;
                kept.push(parts[i]);
            }

            kept.push('maxWidth=' + MAX_WIDTH, 'maxHeight=' + MAX_HEIGHT);
            return base + '?' + kept.join('&');
        },

        stripSubtitleParams: function (pathOrUrl) {
            if (!pathOrUrl) return '';

            var split = pathOrUrl.indexOf('?');
            if (split === -1) return pathOrUrl;

            var parts = pathOrUrl.slice(split + 1).split('&');
            var kept = [];

            for (var i = 0; i < parts.length; i++) {
                var part = parts[i];
                if (!part) continue;
                if (/^Subtitle(StreamIndex|Method)=/i.test(part)) continue;
                kept.push(part);
            }

            return pathOrUrl.slice(0, split) + '?' + kept.join('&');
        },

        /* What the server decided to do with the audio and why, read from the
           transcoding URL it handed back. Shown in the playback info panel so
           "why is this transcoding?" can be answered from the couch. Returns
           null for a URL that carries none of it (direct play). */
        transcodeInfo: function (pathOrUrl) {
            if (!pathOrUrl) return null;
            var split = pathOrUrl.indexOf('?');
            if (split === -1) return null;

            var out = { videoCodec: '', audioCodec: '', audioChannels: 0, reasons: [] };
            var parts = pathOrUrl.slice(split + 1).split('&');
            for (var i = 0; i < parts.length; i++) {
                var eq = parts[i].indexOf('=');
                if (eq === -1) continue;
                var key = parts[i].slice(0, eq).toLowerCase();
                var value = parts[i].slice(eq + 1);
                try { value = decodeURIComponent(value); } catch (e) { /* keep raw */ }
                if (key === 'videocodec') out.videoCodec = value.split(',')[0];
                else if (key === 'audiocodec') out.audioCodec = value.split(',')[0];
                else if (key === 'transcodingmaxaudiochannels' || key === 'maxaudiochannels') {
                    out.audioChannels = Number(value) || 0;
                } else if (key === 'transcodereasons') {
                    out.reasons = value ? value.split(',') : [];
                }
            }
            return out;
        },

        absoluteUrl: function (pathOrUrl) {
            if (!pathOrUrl) return '';
            var absolute = /^https?:\/\/([^\/]+)(.*)$/i.exec(pathOrUrl);
            if (absolute) {
                /* Keep an absolute URL only when it points at our own server.
                   withApiKey() appends the token, so a server-supplied foreign
                   host would silently receive it. */
                var base = /^https?:\/\/([^\/]+)/i.exec(state.base || '');
                if (base && absolute[1].toLowerCase() === base[1].toLowerCase()) return pathOrUrl;
                pathOrUrl = absolute[2] || '/';
            }
            return state.base + (pathOrUrl.charAt(0) === '/' ? '' : '/') + pathOrUrl;
        },

        withApiKey: function (absoluteUrl) {
            if (!absoluteUrl) return '';
            if (/[?&]api_key=/i.test(absoluteUrl)) return absoluteUrl;
            return absoluteUrl + (absoluteUrl.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + encodeURIComponent(state.token);
        },

        reportStart: function (info) {
            return request('POST', '/Sessions/Playing', info).catch(function (e) {
                console.warn('reportStart failed', e);
            });
        },

        reportProgress: function (info) {
            return request('POST', '/Sessions/Playing/Progress', info).catch(function (e) {
                console.warn('reportProgress failed', e);
            });
        },

        reportStopped: function (info) {
            return request('POST', '/Sessions/Playing/Stopped', info).catch(function (e) {
                console.warn('reportStopped failed', e);
            });
        },

        markPlayed: function (itemId) {
            return request('POST', '/Users/' + state.userId + '/PlayedItems/' + itemId);
        },

        markUnplayed: function (itemId) {
            return request('DELETE', '/Users/' + state.userId + '/PlayedItems/' + itemId);
        },

        setFavorite: function (itemId, favorite) {
            return request(favorite ? 'POST' : 'DELETE',
                '/Users/' + state.userId + '/FavoriteItems/' + itemId);
        },

        /* ------------------------------------------------------ skip intro */

        mediaSegments: function (itemId) {
            return request('GET', '/MediaSegments/' + itemId, null, {
                includeSegmentTypes: ['Intro', 'Outro', 'Recap', 'Preview', 'Commercial']
            }).catch(function () {
                /* Servers that dislike the filter still return every segment. */
                return request('GET', '/MediaSegments/' + itemId);
            });
        },

        /* Pre-10.10 Intro Skipper plugin endpoint. */
        legacyIntroSegments: function (itemId) {
            return request('GET', '/Episode/' + itemId + '/IntroSkipperSegments');
        },

        /* --------------------------------------------------------- syncplay */

        serverTime: function () {
            return request('GET', '/GetUtcTime');
        },

        syncPlayList: function () {
            return request('GET', '/SyncPlay/List').then(function (r) { return r || []; });
        },

        syncPlayNew: function (groupName) {
            return request('POST', '/SyncPlay/New', { GroupName: groupName || ('TV ' + state.deviceName) });
        },

        syncPlayJoin: function (groupId) {
            return request('POST', '/SyncPlay/Join', { GroupId: groupId });
        },

        syncPlayLeave: function () {
            return request('POST', '/SyncPlay/Leave');
        },

        syncPlayPause: function () { return request('POST', '/SyncPlay/Pause'); },
        syncPlayUnpause: function () { return request('POST', '/SyncPlay/Unpause'); },
        syncPlayStop: function () { return request('POST', '/SyncPlay/Stop'); },

        syncPlaySeek: function (positionTicks) {
            return request('POST', '/SyncPlay/Seek', { PositionTicks: positionTicks });
        },

        syncPlaySetNewQueue: function (itemIds, startIndex, startTicks) {
            return request('POST', '/SyncPlay/SetNewQueue', {
                PlayingQueue: itemIds,
                PlayingItemPosition: startIndex || 0,
                StartPositionTicks: startTicks || 0
            });
        },

        syncPlayReady: function (body) {
            return request('POST', '/SyncPlay/Ready', body).catch(function (e) {
                console.warn('syncPlayReady failed', e);
            });
        },

        syncPlayBuffering: function (body) {
            return request('POST', '/SyncPlay/Buffering', body).catch(function (e) {
                console.warn('syncPlayBuffering failed', e);
            });
        },

        syncPlayPing: function (pingMillis) {
            return request('POST', '/SyncPlay/Ping', { Ping: Math.round(pingMillis || 0) }).catch(function () {});
        },

        syncPlaySetIgnoreWait: function (ignore) {
            return request('POST', '/SyncPlay/SetIgnoreWait', { IgnoreWait: !!ignore }).catch(function () {});
        },

        /* --------------------------------------------------------- websocket */

        openSocket: function (handlers) {
            var ws = null;
            var closed = false;
            var attempts = 0;

            function connect() {
                if (closed || !state.token) return;
                var wsBase = state.base.replace(/^http/i, 'ws');
                /* 12.x rejects ?api_key= with 403 but accepts ?ApiKey=; older
                   servers only know api_key. Both names are harmless together. */
                var target = wsBase + '/socket?api_key=' + encodeURIComponent(state.token) +
                    '&ApiKey=' + encodeURIComponent(state.token) +
                    '&deviceId=' + encodeURIComponent(state.deviceId);

                ws = new WebSocket(target);

                ws.onopen = function () {
                    attempts = 0;
                    if (handlers.onOpen) handlers.onOpen();
                };

                ws.onmessage = function (event) {
                    var message;
                    try { message = JSON.parse(event.data); } catch (e) { return; }

                    if (message.MessageType === 'ForceKeepAlive') {
                        api.send({ MessageType: 'KeepAlive', Data: {} });
                    }
                    if (handlers.onMessage) handlers.onMessage(message);
                };

                ws.onclose = function () {
                    ws = null;
                    if (handlers.onClose) handlers.onClose();
                    if (!closed) {
                        attempts++;
                        setTimeout(connect, Math.min(30000, 1000 * Math.pow(2, Math.min(attempts, 5))));
                    }
                };

                ws.onerror = function () {
                    try { ws.close(); } catch (e) { /* noop */ }
                };
            }

            var api = {
                send: function (message) {
                    if (!ws || ws.readyState !== 1) return false;
                    try { ws.send(JSON.stringify(message)); return true; } catch (e) { return false; }
                },
                close: function () {
                    closed = true;
                    if (ws) { try { ws.close(); } catch (e) { /* noop */ } }
                }
            };

            connect();
            return api;
        }
    };

    global.Api = Api;
})(window);
