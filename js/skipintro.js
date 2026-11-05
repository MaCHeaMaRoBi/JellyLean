/* Skip Intro / Skip Credits.
   Reads Jellyfin 10.10+ Media Segments; falls back to the Intro Skipper plugin
   endpoint used by 10.8/10.9 servers. */
(function (global) {
    'use strict';

    var currentItemId = null;
    var segments = [];
    var skipped = {};
    var loading = false;

    function toArray(result) {
        if (!result) return [];
        if (Object.prototype.toString.call(result) === '[object Array]') return result;
        if (result.Items) return result.Items;
        if (result.IntroSegments) return result.IntroSegments;
        if (result.Segments) return result.Segments;
        return [];
    }

    function normalize(list) {
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var s = list[i] || {};
            var type = s.Type || s.type || 'Intro';
            var start = s.StartTicks !== undefined ? s.StartTicks
                : (s.IntroStartTicks !== undefined ? s.IntroStartTicks : s.Start);
            var end = s.EndTicks !== undefined ? s.EndTicks
                : (s.IntroEndTicks !== undefined ? s.IntroEndTicks : s.End);

            start = Number(start) || 0;
            end = Number(end) || 0;

            if (end > start) {
                out.push({ type: String(type), start: start, end: end });
            }
        }
        out.sort(function (a, b) { return a.start - b.start; });
        return out;
    }

    var SkipIntro = U.emitter({});

    SkipIntro.load = function (itemId) {
        currentItemId = itemId;
        segments = [];
        skipped = {};
        loading = true;

        return Api.mediaSegments(itemId).then(function (result) {
            var parsed = normalize(toArray(result));
            if (parsed.length) return parsed;
            return Api.legacyIntroSegments(itemId).then(function (legacy) {
                return normalize(toArray(legacy));
            });
        }).catch(function () {
            /* 404 on servers without the plugin/segment provider */
            return Api.legacyIntroSegments(itemId).then(function (legacy) {
                return normalize(toArray(legacy));
            }).catch(function () { return []; });
        }).then(function (parsed) {
            if (currentItemId !== itemId) return [];
            segments = parsed;
            loading = false;
            SkipIntro.emit('loaded', segments);
            return segments;
        });
    };

    SkipIntro.reset = function () {
        currentItemId = null;
        segments = [];
        skipped = {};
        loading = false;
        SkipIntro.emit('changed', null);
    };

    SkipIntro.isLoading = function () { return loading; };
    SkipIntro.getSegments = function () { return segments.slice(0); };

    SkipIntro.activeAt = function (positionTicks) {
        for (var i = 0; i < segments.length; i++) {
            var s = segments[i];
            if (positionTicks >= s.start - 5000000 && positionTicks < s.end - 10000000) {
                return s;
            }
        }
        return null;
    };

    SkipIntro.label = function (segment) {
        if (!segment) return '';
        if (segment.type === 'Outro') return 'Skip Credits';
        if (segment.type === 'Recap') return 'Skip Recap';
        if (segment.type === 'Commercial') return 'Skip Ad';
        return 'Skip Intro';
    };

    SkipIntro.skip = function (segment) {
        if (!segment) return null;
        skipped[segment.start + ':' + segment.end] = true;
        SkipIntro.emit('skipped', segment);
        return U.msToTicks(U.ticksToMs(segment.end) + 250);
    };

    /* Used by the player screen to auto-skip at most once per segment. */
    SkipIntro.shouldAutoSkip = function (segment) {
        if (!segment) return false;
        var key = segment.start + ':' + segment.end;
        if (skipped[key]) return false;
        skipped[key] = true;
        return true;
    };

    global.SkipIntro = SkipIntro;
})(window);
