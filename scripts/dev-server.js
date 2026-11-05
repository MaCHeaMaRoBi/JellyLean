#!/usr/bin/env node
/* Dev server: serves the app and a tiny mock Jellyfin API on one origin, so
   the whole client can be exercised in a desktop browser without a TV.
     node scripts/dev-server.js        -> http://localhost:8096
   The mock covers auth, browsing, playback info, a locally generated sample
   video, intro segments and an idle SyncPlay socket. */
'use strict';

var http = require('http');
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var execFileSync = require('child_process').execFileSync;

var ROOT = path.resolve(__dirname, '..');
var PORT = Number(process.env.PORT || 8096);
var MEDIA_DIR = path.join(ROOT, '.dev');
var SAMPLE = path.join(MEDIA_DIR, 'sample.mp4');

var USER = { Id: 'user1', Name: 'Dev' };
var TOKEN = 'devtoken';

var MOVIE_STREAMS = [
    { Type: 'Video', Codec: 'h264', Profile: 'High', Width: 1920, Height: 1080, BitDepth: 8,
        VideoRangeType: 'SDR', AverageFrameRate: 24 },
    { Type: 'Audio', Index: 1, Codec: 'aac', Channels: 2, ChannelLayout: 'stereo',
        Language: 'eng', IsDefault: true },
    /* A second track makes the audio picker reachable: choosing it must ask
       the server for a transcode instead of remuxing the default. */
    { Type: 'Audio', Index: 5, Codec: 'ac3', Channels: 6, ChannelLayout: '5.1',
        Language: 'fra', Title: 'French 5.1' },
    { Type: 'Subtitle', Codec: 'subrip', Language: 'eng', IsTextSubtitleStream: true }
];

var MOVIE = {
    Id: 'movie1', Name: 'Big Buck Bunny', Type: 'Movie', ProductionYear: 2008,
    RunTimeTicks: 2000000000, Overview: 'A large rabbit takes revenge on three rodents. Mock catalogue entry used by the dev server.',
    ImageTags: { Primary: 'movie1' }, BackdropImageTags: ['movie1'],
    UserData: { PlaybackPositionTicks: 0 },
    /* Rich metadata so the detail screen is exercised with the same fields a
       real library returns: cast, crew, genres, certification and streams. */
    Genres: ['Animation', 'Comedy', 'Family'],
    OfficialRating: 'PG', CommunityRating: 7.6, CriticRating: 82,
    Taglines: ['One rabbit. Three rodents. No mercy.'],
    Studios: [{ Id: 'studio1', Name: 'Blender Foundation' }],
    PremiereDate: '2008-04-10T00:00:00.0000000Z',
    MediaStreams: MOVIE_STREAMS,
    MediaSources: [{ Id: 'movie1', Container: 'mp4', Size: 158000000, MediaStreams: MOVIE_STREAMS }],
    People: [
        { Id: 'person1', Name: 'Sacha Goedegebure', Type: 'Director', Role: 'Director', PrimaryImageTag: 'person1' },
        { Id: 'person1', Name: 'Sacha Goedegebure', Type: 'Writer', Role: 'Writer' },
        { Id: 'person2', Name: 'Big Buck Bunny', Type: 'Actor', Role: 'Bunny', PrimaryImageTag: 'person2' },
        { Id: 'person3', Name: 'Frank the Rodent', Type: 'Actor', Role: 'Frank', PrimaryImageTag: 'person3' },
        { Id: 'person4', Name: 'Rinky the Rodent', Type: 'Actor', Role: 'Rinky', PrimaryImageTag: 'person4' }
    ]
};

var SERIES = {
    Id: 'series1', Name: 'Demo Show', Type: 'Series', ProductionYear: 2024,
    Overview: 'A mock series with one season and one episode, enough to exercise the series detail screen.',
    ImageTags: { Primary: 'series1' }, ChildCount: 2, Status: 'Continuing'
};

var SEASON = {
    Id: 'season1', Name: 'Season 1', Type: 'Season', SeriesId: 'series1',
    IndexNumber: 1, ImageTags: { Primary: 'season1' }
};

var EPISODE = {
    Id: 'ep1', Name: 'Pilot', Type: 'Episode', SeriesId: 'series1', SeasonId: 'season1',
    SeriesName: 'Demo Show', ParentIndexNumber: 1, IndexNumber: 1,
    RunTimeTicks: 200000000,
    Overview: 'The first mock episode. An intro marker sits between 0:02 and 0:06 so Skip Intro can be tested.',
    ImageTags: { Primary: 'ep1' }, UserData: { PlaybackPositionTicks: 0 }
};

/* Up Next needs a different episode to hand back; the same one would be
   filtered out by the player before the overlay can appear. */
var EPISODE2 = {
    Id: 'ep2', Name: 'Second Episode', Type: 'Episode', SeriesId: 'series1', SeasonId: 'season1',
    SeriesName: 'Demo Show', ParentIndexNumber: 1, IndexNumber: 2,
    RunTimeTicks: 1200000000,
    Overview: 'The second mock episode, used by the Next Up and autoplay tests.',
    ImageTags: { Primary: 'ep2' }, UserData: { PlaybackPositionTicks: 0 }
};

var MOVIES_LIB = { Id: 'lib-movies', Name: 'Movies', Type: 'CollectionFolder', CollectionType: 'movies', IsFolder: true };
var TV_LIB = { Id: 'lib-tv', Name: 'TV Shows', Type: 'CollectionFolder', CollectionType: 'tvshows', IsFolder: true };

/* Only reachable through "More Like This"; kept out of the library listing so
   the browse screens stay small. */
var SIMILAR = [
    { Id: 'movie2', Name: 'Sintel', Type: 'Movie', ProductionYear: 2010,
        RunTimeTicks: 900000000, ImageTags: { Primary: 'movie2' }, UserData: {} },
    { Id: 'movie3', Name: 'Elephants Dream', Type: 'Movie', ProductionYear: 2006,
        RunTimeTicks: 660000000, ImageTags: { Primary: 'movie3' }, UserData: {} }
];

var ITEMS = {};
[MOVIE, SERIES, SEASON, EPISODE, EPISODE2].concat(SIMILAR).forEach(function (item) { ITEMS[item.Id] = item; });
(MOVIE.People || []).forEach(function (person) { ITEMS[person.Id] = person; });


/* ---------------------------------------------------------- rich catalogue
   RICH=1 fills the library with enough titles, artwork and progress to judge a
   10-foot layout (shelves, grids, long titles). The default mock stays tiny so
   the smoke suite's counts do not move. */
var RICH = process.env.RICH === '1';
var RICH_MOVIES = [];
var RICH_SERIES = [];
var RICH_RESUME = [];

if (RICH) {
    var movieNames = ['Sintel', 'Tears of Steel', 'Cosmos Laundromat', 'Spring', 'Agent 327', 'The Long Tide',
        'Northern Quiet', 'Salt Line', 'Paper Lanterns', 'Midnight at the Observatory', 'A Field of Static',
        'Harbour Lights', 'The Cartographer', 'Ember and Ash', 'Low Orbit', 'Quiet Machines', 'Glass Garden',
        'The Winter Ferry', 'Copper Sky', 'Last Train to Verne', 'Small Hours', 'Neon Orchard', 'The Third Bell',
        'Where the River Bends'];
    var genrePool = [['Drama'], ['Sci-Fi', 'Thriller'], ['Animation', 'Family'], ['Comedy'], ['Mystery', 'Drama'],
        ['Adventure'], ['Documentary'], ['Fantasy', 'Adventure']];
    movieNames.forEach(function (name, i) {
        var id = 'rm' + (i + 1);
        RICH_MOVIES.push({
            Id: id, Name: name, Type: 'Movie', ProductionYear: 1998 + ((i * 7) % 27),
            RunTimeTicks: (5400 + (i * 431) % 4200) * 10000000,
            Overview: 'An invented catalogue entry for layout testing. ' + name + ' follows a small crew through one very long night, where every decision narrows the way back and the quiet between lines of dialogue says more than the script.',
            ImageTags: { Primary: id, Thumb: id, Logo: i % 3 === 0 ? id : undefined },
            BackdropImageTags: [id], Genres: genrePool[i % genrePool.length],
            OfficialRating: ['PG', 'PG-13', 'R', 'TV-14'][i % 4], CommunityRating: 6 + ((i * 13) % 30) / 10,
            UserData: { PlaybackPositionTicks: 0, Played: i % 5 === 2 }
        });
    });
    var seriesNames = ['Harbor Street', 'The Lighthouse Years', 'Deep Field', 'Nine Rooms', 'Saltwater Code',
        'Understudy', 'The Long Con of Margaret Hale', 'Orchard Road', 'Static', 'Winter Garden'];
    seriesNames.forEach(function (name, i) {
        var id = 'rs' + (i + 1);
        RICH_SERIES.push({
            Id: id, Name: name, Type: 'Series', ProductionYear: 2009 + i, ChildCount: 2 + (i % 4),
            Overview: 'An invented series for layout testing. ' + name + ' returns for another season of slow-burning secrets.',
            ImageTags: { Primary: id, Thumb: id, Logo: i % 2 === 0 ? id : undefined }, BackdropImageTags: [id],
            Genres: genrePool[(i + 3) % genrePool.length], OfficialRating: 'TV-MA', CommunityRating: 7 + (i % 20) / 10,
            UserData: { UnplayedItemCount: i % 3 === 0 ? 4 + i : 0 }
        });
    });
    RICH_RESUME = [RICH_MOVIES[3], RICH_MOVIES[7], RICH_MOVIES[11]].map(function (m, i) {
        m.UserData.PlaybackPositionTicks = (900 + i * 700) * 10000000;
        return m;
    });
    RICH_MOVIES.concat(RICH_SERIES).forEach(function (item) { ITEMS[item.Id] = item; });
}

/* ------------------------------------------------------------- seerr data */

var SEERR_CAST = [
    { id: 6384, name: 'Keanu Reeves', character: 'Neo', profilePath: '/4D0PpNI0kmP58hgrwGC3wCjxhnm.jpg' },
    { id: 2975, name: 'Laurence Fishburne', character: 'Morpheus', profilePath: '/8suOhUmPbfKqDQ17jQ1Gy0mI3P4.jpg' },
    { id: 530, name: 'Carrie-Anne Moss', character: 'Trinity', profilePath: '/xVE4E2eL0b0b2bYf0a1S3vP9x4j.jpg' }
];

var SEERR_MOVIES = [
    {
        id: 603, mediaType: 'movie', title: 'The Matrix', originalTitle: 'The Matrix',
        releaseDate: '1999-03-31', voteAverage: 8.2, voteCount: 24567, runtime: 136,
        overview: 'A computer hacker learns from mysterious rebels about the true nature of his reality and his role in the war against its controllers.',
        tagline: 'Welcome to the real world.',
        posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg',
        backdropPath: '/icmmSD6rNQn1Fk4T8kC2mS0bq3S.jpg',
        genres: [{ id: 28, name: 'Action' }, { id: 878, name: 'Science Fiction' }],
        credits: { cast: SEERR_CAST },
        mediaInfo: { status: 5, jellyfinMediaId: 'movie1' },
        watchProviders: [
            { iso_3166_1: 'US', flatrate: [
                { displayPriority: 1, name: 'Max', logoPath: '/8z7rC8j2m5X1l4p7Q9t3v6N0k2R.jpg' },
                { displayPriority: 2, name: 'Hulu', logoPath: '/pqUTCleNUiTLAVlelGxUgWn1ELh.jpg' }
            ], rent: [{ displayPriority: 1, name: 'Apple TV', logoPath: '/peURlLlr8jggOwK53fJ5wdQl05y.jpg' }],
              buy: [{ displayPriority: 1, name: 'Amazon Video', logoPath: '/5NyLm42TmCqCMOZFvH4fcoCL5cf.jpg' }] },
            { iso_3166_1: 'RO', flatrate: [
                { displayPriority: 1, name: 'Netflix', logoPath: '/9A1JSVmSIMq5ReRHxRDMu4Ol4S0.jpg' }
            ] }
        ]
    },
    {
        id: 27205, mediaType: 'movie', title: 'Inception', originalTitle: 'Inception',
        releaseDate: '2010-07-15', voteAverage: 8.4, voteCount: 36000, runtime: 148,
        overview: 'A thief who steals corporate secrets through the use of dream-sharing technology is given the inverse task of planting an idea into the mind of a C.E.O.',
        tagline: 'Your mind is the scene of the crime.',
        posterPath: '/9gk7adHYeDvHkCSEqAvQNLV5Uge.jpg',
        backdropPath: '/s3TBrRGB1iav7gFOCNx3H31MoES.jpg',
        genres: [{ id: 28, name: 'Action' }, { id: 53, name: 'Thriller' }],
        credits: { cast: SEERR_CAST },
        mediaInfo: { status: 1 }
    },
    {
        id: 550, mediaType: 'movie', title: 'Fight Club', originalTitle: 'Fight Club',
        releaseDate: '1999-10-15', voteAverage: 8.4, voteCount: 29000, runtime: 139,
        overview: 'An insomniac office worker and a devil-may-care soap maker form an underground fight club.',
        tagline: 'Mischief. Mayhem. Soap.',
        posterPath: '/pB8BM7pdSp6B6Ih7QZ4DrQ3PmJK.jpg',
        backdropPath: '/hZkgoQYus5vegHoetLkCJzb17zJ.jpg',
        genres: [{ id: 18, name: 'Drama' }],
        credits: { cast: SEERR_CAST },
        mediaInfo: { status: 5 }
    },
    {
        id: 13, mediaType: 'movie', title: 'Forrest Gump', originalTitle: 'Forrest Gump',
        releaseDate: '1994-07-06', voteAverage: 8.5, voteCount: 27000, runtime: 142,
        overview: 'The presidencies of Kennedy and Johnson unfold through the perspective of an Alabama man.',
        posterPath: '/arw2vcBveWOVZr6pxd9XTd1TdQa.jpg',
        backdropPath: '/7c9UVPPiTPltouxRVY6N9uugaVA.jpg',
        genres: [{ id: 35, name: 'Comedy' }, { id: 18, name: 'Drama' }],
        credits: { cast: SEERR_CAST },
        mediaInfo: { status: 1 }
    },
    {
        id: 680, mediaType: 'movie', title: 'Pulp Fiction', originalTitle: 'Pulp Fiction',
        releaseDate: '1994-09-10', voteAverage: 8.5, voteCount: 28000, runtime: 154,
        overview: 'The lives of two mob hitmen, a boxer, a gangster and his wife intertwine in four tales of violence.',
        posterPath: '/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg',
        backdropPath: '/suaEOtk1N1sgg2MTM7oZd2cfVp3.jpg',
        genres: [{ id: 80, name: 'Crime' }],
        credits: { cast: SEERR_CAST },
        mediaInfo: { status: 1 }
    },
    {
        id: 155, mediaType: 'movie', title: 'The Dark Knight', originalTitle: 'The Dark Knight',
        releaseDate: '2008-07-16', voteAverage: 8.5, voteCount: 32000, runtime: 152,
        overview: 'When the menace known as the Joker wreaks havoc on Gotham, Batman must accept one of the greatest psychological tests.',
        posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg',
        backdropPath: '/hkBaDkMWbLaf8B1lsWsKX7Ew3Xq.jpg',
        genres: [{ id: 28, name: 'Action' }],
        credits: { cast: SEERR_CAST },
        mediaInfo: { status: 1 }
    }
];

var SEERR_TV = [
    {
        id: 1399, mediaType: 'tv', name: 'Game of Thrones', originalName: 'Game of Thrones',
        firstAirDate: '2011-04-17', voteAverage: 8.4, voteCount: 22000,
        numberOfSeasons: 3, numberOfEpisodes: 30, status: 'Ended',
        overview: 'Seven noble families fight for control of the mythical land of Westeros.',
        tagline: 'Winter is coming.',
        posterPath: '/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg',
        backdropPath: '/suopoADq0k8YZr4dQXcU6pToj6s.jpg',
        genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 18, name: 'Drama' }],
        credits: { cast: SEERR_CAST },
        seasons: [
            { seasonNumber: 1, name: 'Season 1', episodeCount: 10, airDate: '2011-04-17' },
            { seasonNumber: 2, name: 'Season 2', episodeCount: 10, airDate: '2012-04-01' },
            { seasonNumber: 3, name: 'Season 3', episodeCount: 10, airDate: '2013-03-31' }
        ],
        mediaInfo: {
            status: 4,
            seasons: [
                { seasonNumber: 1, status: 5 },
                { seasonNumber: 2, status: 2 },
                { seasonNumber: 3, status: 1 }
            ]
        }
    },
    {
        id: 1396, mediaType: 'tv', name: 'Breaking Bad', originalName: 'Breaking Bad',
        firstAirDate: '2008-01-20', voteAverage: 8.9, voteCount: 25000,
        numberOfSeasons: 2, numberOfEpisodes: 20, status: 'Ended',
        overview: 'A high school chemistry teacher diagnosed with lung cancer turns to manufacturing drugs.',
        posterPath: '/ggFHVNu6YYI5L9pCfOacjizRGt.jpg',
        backdropPath: '/tsRy63Mu5cu8etL1X7ZLyf7UP1M.jpg',
        genres: [{ id: 18, name: 'Drama' }],
        credits: { cast: SEERR_CAST },
        seasons: [
            { seasonNumber: 1, name: 'Season 1', episodeCount: 7, airDate: '2008-01-20' },
            { seasonNumber: 2, name: 'Season 2', episodeCount: 13, airDate: '2009-03-08' }
        ],
        mediaInfo: { status: 1, seasons: [
            { seasonNumber: 1, status: 1 }, { seasonNumber: 2, status: 1 }
        ] }
    },
    {
        id: 66732, mediaType: 'tv', name: 'Stranger Things', originalName: 'Stranger Things',
        firstAirDate: '2016-07-15', voteAverage: 8.6, voteCount: 17000,
        numberOfSeasons: 1, numberOfEpisodes: 8, status: 'Returning Series',
        overview: 'When a young boy disappears, his mother and friends must confront terrifying forces.',
        posterPath: '/49WJfeN0moxb9IPfGn8AIqMGskD.jpg',
        backdropPath: '/56v2KjBlU4XaOv9rVYEQypROD7P.jpg',
        genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }],
        credits: { cast: SEERR_CAST },
        seasons: [{ seasonNumber: 1, name: 'Season 1', episodeCount: 8, airDate: '2016-07-15' }],
        mediaInfo: { status: 1, seasons: [{ seasonNumber: 1, status: 1 }] }
    }
];

var SEERR_UPCOMING = SEERR_MOVIES.slice(2, 6).map(function (item) {
    var copy = Object.assign({}, item);
    copy.releaseDate = '2027-0' + ((item.id % 8) + 1) + '-12';
    return copy;
});

var SEERR_ALL = SEERR_MOVIES.concat(SEERR_TV);
var SEERR_TRENDING = [SEERR_MOVIES[0], SEERR_TV[0], SEERR_MOVIES[1], SEERR_TV[1], SEERR_MOVIES[2]];

var seerrRequests = [];
var nextRequestId = 501;

function seerrTitle(item) {
    return item.title || item.name || '';
}

function seerrFind(mediaType, id) {
    var wanted = mediaType === 'tv' ? 'tv' : 'movie';
    for (var i = 0; i < SEERR_ALL.length; i++) {
        if (SEERR_ALL[i].mediaType === wanted && Number(SEERR_ALL[i].id) === Number(id)) {
            return SEERR_ALL[i];
        }
    }
    return null;
}

var wsClients = new Set();
var syncGroup = null;

function wsFrame(message) {
    var payload = Buffer.from(JSON.stringify(message));
    var header;

    if (payload.length < 126) {
        header = Buffer.from([0x81, payload.length]);
    } else if (payload.length < 65536) {
        header = Buffer.alloc(4);
        header[0] = 0x81;
        header[1] = 126;
        header.writeUInt16BE(payload.length, 2);
    } else {
        header = Buffer.alloc(10);
        header[0] = 0x81;
        header[1] = 127;
        header.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    return Buffer.concat([header, payload]);
}

function broadcast(message) {
    var frame = wsFrame(message);
    wsClients.forEach(function (socket) {
        try { socket.write(frame); } catch (e) { /* client went away */ }
    });
}

/* --------------------------------------------------------------- sample */

function ensureSample() {
    if (fs.existsSync(SAMPLE) && fs.statSync(SAMPLE).size > 1000) return;

    if (!fs.existsSync(MEDIA_DIR)) fs.mkdirSync(MEDIA_DIR, { recursive: true });

    try {
        execFileSync('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=25',
            '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
            '-t', '20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast',
            '-c:a', 'aac', '-movflags', 'faststart', SAMPLE
        ], { stdio: 'ignore' });
        console.log('[dev] generated', path.relative(ROOT, SAMPLE));
    } catch (e) {
        console.warn('[dev] ffmpeg unavailable: /Videos requests will 404');
    }
}

/* --------------------------------------------------------------- helpers */

/* Jellyfin 12 only honours these two carriers. It ignores X-Emby-Token, which
   is exactly the mistake the mock needs to catch. */
function requestToken(req, url) {
    var auth = req.headers.authorization || '';
    var match = /Token="([^"]*)"/i.exec(auth);
    if (match) return match[1];
    return url.searchParams.get('ApiKey') || url.searchParams.get('api_key') || '';
}

function json(res, status, payload) {
    var body = JSON.stringify(payload === undefined ? null : payload);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store'
    });
    res.end(body);
}

function noContent(res) {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
}

function readBody(req) {
    return new Promise(function (resolve) {
        var chunks = [];
        req.on('data', function (chunk) { chunks.push(chunk); });
        req.on('end', function () {
            if (!chunks.length) { resolve({}); return; }
            try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch (e) { resolve({}); }
        });
    });
}

function wrapWords(text, max) {
    var words = String(text || '').split(' ');
    var lines = [];
    var line = '';
    words.forEach(function (w) {
        if ((line + ' ' + w).trim().length > max && line) { lines.push(line); line = w; }
        else line = (line + ' ' + w).trim();
    });
    if (line) lines.push(line);
    return lines.slice(0, 4);
}

function xml(text) { return String(text).replace(/[<>&"]/g, ''); }

function hueFor(item) {
    var hue = 0;
    for (var i = 0; i < item.Id.length; i++) hue = (hue * 31 + item.Id.charCodeAt(i)) % 360;
    return hue;
}

/* Cinematic-ish stand-ins: a graded sky, a horizon, a light source and, on
   posters, the title set the way a one-sheet would. */
function svgPoster(item, kind) {
    var hue = hueFor(item);
    var h2 = (hue + 38) % 360;
    var name = item.Name || '?';

    if (kind === 'Logo') {
        var l = wrapWords(name, 14);
        var tspans = l.map(function (t, i) {
            return '<tspan x="0" dy="' + (i ? 92 : 0) + '">' + xml(t) + '</tspan>';
        }).join('');
        return '<svg xmlns="http://www.w3.org/2000/svg" width="720" height="' + (110 + l.length * 92) +
            '" viewBox="0 0 720 ' + (110 + l.length * 92) + '"><text x="0" y="90" font-family="Georgia, serif" ' +
            'font-weight="700" font-size="96" fill="#fff" letter-spacing="2">' + tspans + '</text></svg>';
    }

    var w = kind === 'Primary' ? 400 : 1600;
    var hgt = kind === 'Primary' ? 600 : 900;
    var horizon = Math.round(hgt * 0.62);
    var sunX = Math.round(w * ((hue % 7) / 10 + 0.25));
    var sunY = Math.round(hgt * 0.44);
    var out = '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + hgt + '" viewBox="0 0 ' + w + ' ' + hgt + '">' +
        '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">' +
        '<stop offset="0" stop-color="hsl(' + hue + ',46%,16%)"/>' +
        '<stop offset="0.7" stop-color="hsl(' + h2 + ',58%,38%)"/>' +
        '<stop offset="1" stop-color="hsl(' + h2 + ',64%,52%)"/></linearGradient>' +
        '<radialGradient id="sun"><stop offset="0" stop-color="hsl(' + ((hue + 60) % 360) + ',90%,82%)" stop-opacity="0.95"/>' +
        '<stop offset="1" stop-color="hsl(' + ((hue + 60) % 360) + ',90%,70%)" stop-opacity="0"/></radialGradient></defs>' +
        '<rect width="' + w + '" height="' + hgt + '" fill="url(#sky)"/>' +
        '<circle cx="' + sunX + '" cy="' + sunY + '" r="' + Math.round(hgt * 0.34) + '" fill="url(#sun)"/>' +
        '<path d="M0 ' + horizon + ' Q' + Math.round(w * 0.25) + ' ' + (horizon - hgt * 0.1) + ' ' + Math.round(w * 0.5) + ' ' + (horizon - hgt * 0.03) +
        ' T' + w + ' ' + (horizon - hgt * 0.08) + ' V' + hgt + ' H0Z" fill="hsl(' + hue + ',40%,9%)"/>' +
        '<path d="M0 ' + (horizon + hgt * 0.08) + ' Q' + Math.round(w * 0.4) + ' ' + (horizon - hgt * 0.02) + ' ' + w + ' ' + (horizon + hgt * 0.1) +
        ' V' + hgt + ' H0Z" fill="hsl(' + hue + ',44%,5%)"/>';
    if (kind === 'Primary') {
        var lines = wrapWords(name.toUpperCase(), 11);
        lines.forEach(function (t, i) {
            out += '<text x="200" y="' + (410 + i * 46) + '" text-anchor="middle" font-family="Georgia, serif" font-weight="700" ' +
                'font-size="40" fill="#fff" letter-spacing="3">' + xml(t) + '</text>';
        });
    }
    return out + '</svg>';
}

function serveVideo(req, res) {
    var stat;
    try { stat = fs.statSync(SAMPLE); } catch (e) { res.writeHead(404); res.end('no sample'); return; }

    var range = req.headers.range;
    var size = stat.size;

    if (!range) {
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Length': size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-store'
        });
        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(SAMPLE).pipe(res);
        return;
    }

    var match = /bytes=(\d*)-(\d*)/.exec(range);
    var start = match && match[1] ? parseInt(match[1], 10) : 0;
    var end = match && match[2] ? parseInt(match[2], 10) : size - 1;
    end = Math.min(end, size - 1);

    if (start >= size || start > end) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size });
        res.end();
        return;
    }

    res.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
        'Content-Length': end - start + 1,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store'
    });

    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(SAMPLE, { start: start, end: end }).pipe(res);
}

/* ------------------------------------------------------------------ api */

async function handleApi(req, res, url) {
    var pathname = url.pathname;
    var method = req.method;
    var parts;

    var anonymous = pathname === '/System/Info/Public' ||
        pathname === '/Users/AuthenticateByName' ||
        pathname === '/Users/AuthenticateWithQuickConnect' ||
        pathname.indexOf('/QuickConnect/') === 0 ||
        pathname === '/GetUtcTime';

    /* Only the API is guarded; the app's own static files must stay reachable. */
    var isApiPath = /^\/(Users|Items|Shows|MediaSegments|Episode|SyncPlay|Sessions|Videos|System|PlaybackInfo|GetUtcTime|QuickConnect|Litefin)\b/.test(pathname);

    if (isApiPath && !anonymous && requestToken(req, url) !== TOKEN) {
        res.writeHead(401, { 'Content-Length': '0' });
        res.end();
        return true;
    }

    if (pathname === '/System/Info/Public') {
        json(res, 200, { ServerName: 'Fake Jellyfin', Version: '10.10.7', Id: 'devserver', StartupWizardCompleted: true });
        return true;
    }

    if (pathname === '/Users/AuthenticateByName' && method === 'POST') {
        var body = await readBody(req);
        if (!body.Username) { json(res, 401, { Message: 'Username required' }); return true; }
        json(res, 200, { AccessToken: TOKEN, ServerId: 'devserver', User: USER });
        return true;
    }

    if (pathname === '/Users/AuthenticateWithQuickConnect' && method === 'POST') {
        json(res, 200, { AccessToken: TOKEN, ServerId: 'devserver', User: USER });
        return true;
    }

    if (pathname === '/QuickConnect/Enabled') { json(res, 200, false); return true; }
    if (pathname === '/QuickConnect/Initiate') { json(res, 200, { Secret: 'devsecret', Code: '123456' }); return true; }
    if (pathname === '/QuickConnect/Connect') { json(res, 200, { Authenticated: false }); return true; }

    if (pathname === '/Users/Me') { json(res, 200, USER); return true; }
    if (pathname === '/Sessions/Logout' && method === 'POST') { noContent(res); return true; }

    if (pathname === '/Users/' + USER.Id + '/Views') {
        json(res, 200, { Items: [MOVIES_LIB, TV_LIB], TotalRecordCount: 2 });
        return true;
    }

    if (pathname === '/Users/' + USER.Id + '/Items/Resume') {
        json(res, 200, { Items: RICH_RESUME, TotalRecordCount: RICH_RESUME.length });
        return true;
    }

    if (pathname === '/Users/' + USER.Id + '/Items/Latest') {
        var parent = url.searchParams.get('ParentId');
        if (parent === TV_LIB.Id) { json(res, 200, [SERIES].concat(RICH_SERIES).slice(0, 14)); return true; }
        if (parent === MOVIES_LIB.Id) { json(res, 200, [MOVIE].concat(RICH_MOVIES).slice(0, 14)); return true; }
        json(res, 200, [MOVIE, SERIES]);
        return true;
    }

    if (pathname === '/Users/' + USER.Id + '/Items' && method === 'GET') {
        var parentId = url.searchParams.get('ParentId');
        var items;
        if (parentId === MOVIES_LIB.Id) items = [MOVIE].concat(RICH_MOVIES);
        else if (parentId === TV_LIB.Id) items = [SERIES].concat(RICH_SERIES);
        else if (parentId === SERIES.Id || parentId === SEASON.Id) items = [SEASON, EPISODE, EPISODE2];
        else items = [MOVIE, SERIES].concat(RICH_MOVIES, RICH_SERIES);

        /* The unified search screen sends SearchTerm; without filtering here
           every query would return the whole mock catalogue. */
        var term = String(url.searchParams.get('SearchTerm') || '').toLowerCase();
        if (term) {
            items = items.filter(function (item) {
                return String(item.Name || '').toLowerCase().indexOf(term) !== -1 ||
                    String(item.SeriesName || '').toLowerCase().indexOf(term) !== -1;
            });
        }

        var include = url.searchParams.get('IncludeItemTypes');
        if (include) {
            var allowed = include.split(',');
            items = items.filter(function (item) { return allowed.indexOf(item.Type) !== -1; });
        }
        json(res, 200, { Items: items, TotalRecordCount: items.length, StartIndex: 0 });
        return true;
    }

    parts = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(pathname);
    if (parts) {
        var found = ITEMS[parts[1]];
        if (!found) { json(res, 404, { Message: 'Item not found' }); return true; }
        json(res, 200, found);
        return true;
    }

    parts = /^\/Shows\/([^/]+)\/Seasons$/.exec(pathname);
    if (parts) { json(res, 200, { Items: [SEASON], TotalRecordCount: 1 }); return true; }

    parts = /^\/Shows\/([^/]+)\/Episodes$/.exec(pathname);
    if (parts) { json(res, 200, { Items: [EPISODE, EPISODE2], TotalRecordCount: 2 }); return true; }

    if (pathname === '/Shows/NextUp') { json(res, 200, { Items: [EPISODE2], TotalRecordCount: 1 }); return true; }

    parts = /^\/Items\/([^/]+)\/Similar$/.exec(pathname);
    if (parts) {
        var others = [MOVIE].concat(SIMILAR).filter(function (item) {
            return item.Id !== parts[1];
        }).slice(0, 12);
        json(res, 200, { Items: others, TotalRecordCount: others.length });
        return true;
    }

    parts = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(pathname);
    if (parts && method === 'POST') {
        var item = ITEMS[parts[1]];
        if (!item) { json(res, 404, { Message: 'Item not found' }); return true; }

        var request = await readBody(req);
        var direct = request.EnableDirectPlay !== false;
        var sourceId = 'ms-' + item.Id;
        var transcodeUrl = '/Videos/' + item.Id + '/stream?static=true&MediaSourceId=' +
            sourceId + '&PlaySessionId=devsession';
        var subtitleIndex = request.SubtitleStreamIndex;
        var audioIndex = request.AudioStreamIndex;

        /* A named source lets the server honour the selected track, exactly as
           the real server does. Image tracks arrive as a burn-in request. */
        if (typeof subtitleIndex === 'number' && subtitleIndex >= 0) {
            transcodeUrl += '&SubtitleStreamIndex=' + subtitleIndex +
                '&SubtitleMethod=Encode';
        }
        if (typeof audioIndex === 'number' && audioIndex >= 0) {
            transcodeUrl += '&AudioStreamIndex=' + audioIndex;
        }

        json(res, 200, {
            PlaySessionId: 'devsession',
            MediaSources: [{
                Id: sourceId,
                Name: item.Name,
                Container: 'mp4',
                RunTimeTicks: item.RunTimeTicks,
                SupportsDirectPlay: direct,
                SupportsDirectStream: direct,
                SupportsTranscoding: true,
                DirectStreamUrl: '/Videos/' + item.Id + '/stream?static=true&MediaSourceId=' + sourceId + '&PlaySessionId=devsession',
                TranscodingUrl: direct ? null : transcodeUrl,
                MediaStreams: [
                    { Type: 'Video', Index: 0, Codec: 'h264', Width: 640, Height: 360 },
                    { Type: 'Audio', Index: 1, Codec: 'aac', Channels: 2, Language: 'eng',
                      IsDefault: true },
                    { Type: 'Audio', Index: 5, Codec: 'ac3', Channels: 6, Language: 'fra',
                      Title: 'French 5.1' },
                    /* Jellyfin marks a forced/default track this way; the player
                       is expected to draw it instead of asking for a burn-in. */
                    { Type: 'Subtitle', Index: 2, Codec: 'subrip', Language: 'ron',
                      IsDefault: true, IsForced: true, DeliveryMethod: 'External' },
                    { Type: 'Subtitle', Index: 3, Codec: 'subrip', Language: 'eng',
                      DeliveryMethod: 'External' },
                    /* An image track cannot be drawn as WebVTT; selecting it
                       must restart playback with a burned-in transcode. */
                    { Type: 'Subtitle', Index: 4, Codec: 'PGSSUB', Language: 'jpn',
                      DeliveryMethod: 'Encode' }
                ]
            }]
        });
        return true;
    }

    parts = /^\/Items\/([^/]+)\/Images\/([^/]+)(?:\/\d+)?$/.exec(pathname);
    if (parts) {
        var subject = ITEMS[parts[1]] || { Id: parts[1], Name: '?' };
        var svg = svgPoster(subject, parts[2] === 'Primary' ? 'Primary' : (parts[2] === 'Logo' ? 'Logo' : 'Backdrop'));
        res.writeHead(200, {
            'Content-Type': 'image/svg+xml; charset=utf-8',
            'Content-Length': Buffer.byteLength(svg),
            'Cache-Control': 'no-store'
        });
        res.end(svg);
        return true;
    }

    parts = /^\/MediaSegments\/([^/]+)$/.exec(pathname);
    if (parts) {
        var rawTypes = url.searchParams.get('includeSegmentTypes');
        if (rawTypes && rawTypes.indexOf(',') !== -1) {
            json(res, 400, {
                title: 'One or more validation errors occurred.', status: 400,
                errors: { includeSegmentTypes: ['The value \'' + rawTypes + '\' is not valid.'] }
            });
            return true;
        }
        json(res, 200, {
            Items: [{ Type: 'Intro', StartTicks: 20000000, EndTicks: 60000000 }]
        });
        return true;
    }

    parts = /^\/Episode\/([^/]+)\/IntroSkipperSegments$/.exec(pathname);
    if (parts) { json(res, 200, []); return true; }

    if (pathname === '/GetUtcTime') {
        var now = new Date();
        json(res, 200, {
            RequestReceptionTime: now.toISOString(),
            ResponseTransmissionTime: new Date(now.getTime() + 2).toISOString()
        });
        return true;
    }


    /* ------------------------------------------------------- Seerr mock */
    /* The Litefin plugin proxies Seerr; these fixtures mirror the shapes the
       real plugin returns so Discover, detail, requests and the watchlist can
       be exercised without a Seerr instance. */
    if (pathname.indexOf('/Litefin/Seerr') === 0) {
        var seerrPath = pathname.slice('/Litefin/Seerr'.length);

        if (seerrPath === '/Status') {
            json(res, 200, { configured: true, available: true });
            return true;
        }

        if (seerrPath === '/User') {
            json(res, 200, { id: 1, displayName: 'Dev', permissions: 2 });
            return true;
        }

        if (seerrPath === '/Discover/Trending') {
            json(res, 200, { page: 1, results: SEERR_TRENDING, totalPages: 1 });
            return true;
        }
        if (seerrPath === '/Discover/Movies') {
            json(res, 200, { page: 1, results: SEERR_MOVIES, totalPages: 1 });
            return true;
        }
        if (seerrPath === '/Discover/Tv') {
            json(res, 200, { page: 1, results: SEERR_TV, totalPages: 1 });
            return true;
        }
        if (seerrPath === '/Discover/Movies/Upcoming') {
            json(res, 200, { page: 1, results: SEERR_UPCOMING, totalPages: 1 });
            return true;
        }
        if (seerrPath === '/Discover/Tv/Upcoming') {
            json(res, 200, { page: 1, results: SEERR_TV, totalPages: 1 });
            return true;
        }

        if (seerrPath === '/Search') {
            var term = String(url.searchParams.get('query') || '').toLowerCase();
            var hits = SEERR_ALL.filter(function (item) {
                return seerrTitle(item).toLowerCase().indexOf(term) !== -1;
            });
            json(res, 200, { page: 1, results: hits, totalPages: 1 });
            return true;
        }

        if (seerrPath === '/Requests' && method === 'GET') {
            json(res, 200, seerrRequests.slice());
            return true;
        }
        if (seerrPath === '/Requests' && method === 'POST') {
            var requestBody = await readBody(req);
            var target = seerrFind(requestBody.mediaType, requestBody.mediaId);
            if (!target) { json(res, 404, { message: 'Title not found' }); return true; }

            var record = {
                id: nextRequestId++,
                status: 2,
                media: { id: target.id, mediaType: target.mediaType },
                requestedBy: { id: 1, displayName: 'Dev' },
                seasons: requestBody.seasons || []
            };
            seerrRequests.push(record);

            target.mediaInfo = target.mediaInfo || {};
            target.mediaInfo.status = 2;
            target.mediaInfo.requests = (target.mediaInfo.requests || []).concat([{ id: record.id }]);
            if (requestBody.mediaType === 'tv') {
                target.mediaInfo.seasons = target.mediaInfo.seasons || [];
                requestBody.seasons.forEach(function (number) {
                    var found = null;
                    for (var i = 0; i < target.mediaInfo.seasons.length; i++) {
                        if (Number(target.mediaInfo.seasons[i].seasonNumber) === Number(number)) {
                            found = target.mediaInfo.seasons[i];
                        }
                    }
                    if (found) found.status = 2;
                    else target.mediaInfo.seasons.push({ seasonNumber: Number(number), status: 2 });
                });
            }
            json(res, 201, record);
            return true;
        }

        parts = /^\/Requests\/(\d+)$/.exec(seerrPath);
        if (parts && method === 'DELETE') {
            var requestId = Number(parts[1]);
            var index = -1;
            for (var i = 0; i < seerrRequests.length; i++) {
                if (seerrRequests[i].id === requestId) index = i;
            }
            if (index < 0) { json(res, 404, { message: 'Request not found' }); return true; }

            var removed = seerrRequests.splice(index, 1)[0];
            var owner = seerrFind(removed.media.mediaType, removed.media.id);
            if (owner && owner.mediaInfo) {
                owner.mediaInfo.status = 1;
                owner.mediaInfo.requests = [];
                if (removed.seasons && removed.seasons.length) {
                    (owner.mediaInfo.seasons || []).forEach(function (season) {
                        if (removed.seasons.indexOf(Number(season.seasonNumber)) !== -1) season.status = 1;
                    });
                }
            }
            noContent(res);
            return true;
        }

        if (seerrPath === '/Watchlist' && method === 'GET') {
            json(res, 200, SEERR_ALL.filter(function (item) { return item.onUserWatchlist; }));
            return true;
        }
        if (seerrPath === '/Watchlist' && method === 'POST') {
            var watchBody = await readBody(req);
            var watchTarget = seerrFind(watchBody.mediaType, watchBody.mediaId);
            if (!watchTarget) { json(res, 404, { message: 'Title not found' }); return true; }
            watchTarget.onUserWatchlist = true;
            json(res, 201, { mediaType: watchBody.mediaType, mediaId: watchBody.mediaId });
            return true;
        }

        parts = /^\/Watchlist\/(movie|tv)\/(\d+)$/.exec(seerrPath);
        if (parts && method === 'DELETE') {
            var watchRemove = seerrFind(parts[1], Number(parts[2]));
            if (watchRemove) watchRemove.onUserWatchlist = false;
            noContent(res);
            return true;
        }

        parts = /^\/(Movie|Tv)\/(\d+)(\/Similar)?$/.exec(seerrPath);
        if (parts) {
            var mediaType = parts[1] === 'Tv' ? 'tv' : 'movie';
            var found = seerrFind(mediaType, Number(parts[2]));
            if (!found) { json(res, 404, { message: 'Title not found' }); return true; }

            if (parts[3]) {
                var similar = SEERR_ALL.filter(function (item) {
                    return item !== found && item.mediaType === mediaType;
                }).slice(0, 6);
                json(res, 200, { page: 1, results: similar, totalPages: 1 });
                return true;
            }

            json(res, 200, found);
            return true;
        }

        json(res, 404, { message: 'Unknown Seerr route ' + seerrPath });
        return true;
    }

    if (pathname === '/SyncPlay/List') { json(res, 200, syncGroup ? [syncGroup] : []); return true; }

    if (pathname === '/SyncPlay/New' && method === 'POST') {
        var groupRequest = await readBody(req);
        syncGroup = {
            GroupId: 'group1',
            GroupName: groupRequest.GroupName || 'Dev group',
            Participants: ['Dev'],
            State: 'Idle',
            LastUpdatedAt: new Date().toISOString()
        };
        json(res, 200, syncGroup);
        broadcast({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'GroupJoined', Data: syncGroup } });
        return true;
    }

    if (pathname === '/SyncPlay/Join' && method === 'POST') {
        if (!syncGroup) { json(res, 404, { Message: 'Group not found' }); return true; }
        json(res, 200, syncGroup);
        broadcast({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'GroupJoined', Data: syncGroup } });
        return true;
    }

    if (pathname === '/SyncPlay/Leave' && method === 'POST') {
        syncGroup = null;
        json(res, 200, {});
        broadcast({ MessageType: 'SyncPlayGroupUpdate', Data: { Type: 'GroupLeft', Data: {} } });
        return true;
    }

    if (pathname === '/SyncPlay/SetNewQueue' && method === 'POST') {
        var queueRequest = await readBody(req);
        var queueIds = queueRequest.PlayingQueue || [];
        var queueItemId = queueIds[queueRequest.PlayingItemPosition || 0];

        json(res, 200, {});

        if (queueItemId) {
            broadcast({
                MessageType: 'SyncPlayGroupUpdate',
                Data: {
                    Type: 'PlayQueue',
                    Data: {
                        Playlist: [{ ItemId: queueItemId, PlaylistItemId: 'pl-' + queueItemId }],
                        PlayingItemIndex: 0,
                        StartPositionTicks: queueRequest.StartPositionTicks || 0,
                        LastUpdate: new Date().toISOString(),
                        Reason: 'NewPlaylist'
                    }
                }
            });
        }
        return true;
    }

    if (pathname.indexOf('/SyncPlay/') === 0) { json(res, 200, {}); return true; }

    if (pathname.indexOf('/Sessions/Playing') === 0) { noContent(res); return true; }

    parts = /^\/Users\/[^/]+\/PlayedItems\/[^/]+$/.exec(pathname);
    if (parts) { noContent(res); return true; }

    parts = /^\/Users\/[^/]+\/FavoriteItems\/[^/]+$/.exec(pathname);
    if (parts) { noContent(res); return true; }

    parts = /^\/Videos\/([^/]+)\/([^/]+)\/Subtitles\/(\d+)\/Stream\.vtt$/.exec(pathname);
    if (parts) {
        var index = parts[3];
        if (index === '4') {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('image subtitle is not WebVTT');
            return true;
        }

        var vtt = index === '3'
            ? 'WEBVTT\n\n' +
              '00:00.500 --> 00:04.000\nEnglish mock line\n\n' +
              '00:06.000 --> 00:20.000\nSecond English line\n'
            : 'WEBVTT\n\n' +
              '00:00.500 --> 00:04.000\nMock subtitle line\n\n' +
              '00:06.000 --> 00:20.000\nSecond mock line\n';
        res.writeHead(200, {
            'Content-Type': 'text/vtt; charset=utf-8',
            'Content-Length': Buffer.byteLength(vtt),
            'Access-Control-Allow-Origin': '*'
        });
        res.end(vtt);
        return true;
    }

    parts = /^\/Videos\/([^/]+)\/stream$/.exec(pathname);
    if (parts) { serveVideo(req, res); return true; }

    return false;
}

/* -------------------------------------------------------------- static */

var TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.mp4': 'video/mp4',
    '.ico': 'image/x-icon'
};

function serveStatic(req, res, pathname) {
    var relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    var target = path.resolve(ROOT, relative);

    if (target.indexOf(ROOT + path.sep) !== 0) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(target, function (err, stat) {
        if (err || !stat.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('Not found: ' + pathname);
            return;
        }

        res.writeHead(200, {
            'Content-Type': TYPES[path.extname(target).toLowerCase()] || 'application/octet-stream',
            'Content-Length': stat.size,
            'Cache-Control': 'no-store'
        });

        if (req.method === 'HEAD') { res.end(); return; }
        fs.createReadStream(target).pipe(res);
    });
}

/* ---------------------------------------------------------------- server */

ensureSample();

var server = http.createServer(function (req, res) {
    var url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    var started = Date.now();

    res.on('finish', function () {
        if (process.env.QUIET) return;
        console.log('[dev] ' + req.method + ' ' + url.pathname + ' ' + res.statusCode + ' ' + (Date.now() - started) + 'ms');
    });

    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
        });
        res.end();
        return;
    }

    /* index.html includes $WEBAPIS/webapis/webapis.js, which only the TV's web
       engine resolves. Serve an empty stub so desktop consoles stay clean. */
    if (url.pathname === '/$WEBAPIS/webapis/webapis.js' ||
        url.pathname === '/%24WEBAPIS/webapis/webapis.js') {
        res.writeHead(200, { 'Content-Type': 'application/javascript', 'Content-Length': '0' });
        res.end();
        return;
    }

    (process.env.NO_MOCK === '1' ? Promise.resolve(false) : handleApi(req, res, url))
        .then(function (handled) {
        if (!handled) {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
                res.writeHead(405);
                res.end('Method not allowed');
                return;
            }
            serveStatic(req, res, url.pathname);
        }
    }).catch(function (err) {
        console.error('[dev] handler error', err);
        if (!res.headersSent) json(res, 500, { Message: String(err && err.message || err) });
    });
});

/* Idle WebSocket so Api.openSocket() connects and stays quiet. */
server.on('upgrade', function (req, socket) {
    if (!/^\/socket\b/.test(req.url || '')) { socket.destroy(); return; }

    var wsUrl = new URL(req.url, 'http://localhost');
    if (wsUrl.searchParams.get('ApiKey') !== TOKEN) { socket.destroy(); return; }

    var key = req.headers['sec-websocket-key'];
    if (!key) { socket.destroy(); return; }

    var accept = crypto.createHash('sha1')
        .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
        .digest('base64');

    socket.write('HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n');

    wsClients.add(socket);

    socket.on('data', function (buffer) {
        if (buffer.length && (buffer[0] & 0x0f) === 0x8) socket.end();
    });
    socket.on('close', function () { wsClients.delete(socket); });
    socket.on('error', function () { wsClients.delete(socket); });
    console.log('[dev] websocket open');
});

server.listen(PORT, function () {
    console.log('');
    console.log('  JellyLean dev server');
    console.log('  App:      http://localhost:' + PORT + '/');
    console.log('  Server:   http://localhost:' + PORT + '  (enter this on the setup screen)');
    console.log('  Reset:    run localStorage.clear() in DevTools and reload');
    console.log('');
});
