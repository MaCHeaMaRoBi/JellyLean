/* SyncPlay client.
   Implements the server-side protocol used by jellyfin-web:
     - GET  /GetUtcTime              NTP-style offset estimation, reported back via /SyncPlay/Ping
     - WS   /socket                  SyncPlayCommand + SyncPlayGroupUpdate messages
     - POST /SyncPlay/*              group life-cycle, queue and playback commands

   Commands carry a server UTC timestamp (`When`) plus a media position. We
   convert the timestamp to local time with the measured offset and schedule the
   action, then correct drift while playing. */
(function (global) {
    'use strict';

    var TICKS_PER_MS = 10000;

    var state = {
        enabled: false,
        group: null,
        queue: null,
        playlist: [],
        currentPlaylistItemId: null,
        timeOffset: 0,
        measurements: [],
        pings: 0,
        pollInterval: 60000,
        ready: false,
        queuedCommand: null,
        enabledAt: null,
        following: true,
        lastCommand: null,
        syncEnabled: false,
        lastDiff: 0,
        lastSyncCheck: 0,
        playbackActive: false,
        /* Idle | Waiting | Paused | Playing, from StateUpdate messages. */
        groupState: null,
        /* Buffering/ready reports caused by our own corrective seeks must not
           reach the server: it would pause the whole group and answer with a
           fresh Pause/Unpause that makes this client seek again. */
        quietUntil: 0,
        bufferingReported: false,
        /* Drift correction. The TV's position is only sampled every 500 ms and
           is noisy, so single samples are never acted on. */
        driftSamples: [],
        lastHardSeek: 0,
        speedChanged: false,
        localBuffering: false
    };

    /* Hard seeks cost a rebuffer on Tizen (especially HLS transcodes), so they
       are reserved for real desyncs. HTML5 seeks are cheap and can be tighter. */
    var DRIFT_SAMPLES = 5;
    var HARD_SEEK_AVPLAY_MS = 1500;
    var HARD_SEEK_HTML5_MS = 400;
    var HARD_SEEK_COOLDOWN_MS = 8000;

    /* A stall is only announced after it has lasted this long. jellyfin-web
       does the same (HtmlVideoPlayer.minBufferingThresholdMillis); without it
       every dropped buffer pauses the whole group and both sides hitch. */
    var BUFFERING_REPORT_MS = 3000;

    var socket = null;
    var pingTimer = null;
    var pingStopped = true;
    var commandTimer = null;
    var syncTimer = null;
    var bufferingTimer = null;

    var SyncPlay = U.emitter({});

    /* ------------------------------------------------------------ utilities */

    function parseDate(value) {
        if (!value) return null;
        var d = (value instanceof Date) ? value : new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    function localToRemote(date) { return new Date(date.getTime() + state.timeOffset); }
    function remoteToLocal(date) { return new Date(date.getTime() - state.timeOffset); }

    function median(values) {
        var sorted = values.slice(0).sort(function (a, b) { return a - b; });
        return sorted[Math.floor(sorted.length / 2)];
    }

    function resetDrift() { state.driftSamples = []; }

    function restoreSpeed() {
        if (!state.speedChanged) return;
        state.speedChanged = false;
        Player.setSpeed(1);
    }

    function quiet(ms) { state.quietUntil = Date.now() + ms; }
    function isQuiet() { return Date.now() < state.quietUntil; }

    function clearCommandTimer() {
        if (commandTimer) { clearTimeout(commandTimer); commandTimer = null; }
        if (syncTimer) { clearTimeout(syncTimer); syncTimer = null; }
        state.syncEnabled = false;
    }

    function clearBufferingTimer() {
        if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
    }

    /* -------------------------------------------------------------- socket */

    function handleMessage(message) {
        if (!message) return;

        if (message.MessageType === 'SyncPlayCommand') {
            handleCommand(message.Data);
        } else if (message.MessageType === 'SyncPlayGroupUpdate') {
            handleGroupUpdate(message.Data);
        }

        SyncPlay.emit('message', message);
    }

    function handleGroupUpdate(update) {
        if (!update || !update.Type) return;
        var data = update.Data;

        switch (update.Type) {
            case 'GroupJoined':
                enable(data);
                break;

            case 'GroupLeft':
            case 'NotInGroup':
                disable(true);
                break;

            case 'GroupUpdate':
                state.group = data;
                SyncPlay.emit('group', state.group);
                break;

            case 'StateUpdate':
                if (data) {
                    state.groupState = data.State || null;
                    SyncPlay.emit('state', data.State, data.Reason);
                }
                break;

            case 'PlayQueue':
                handlePlayQueue(data);
                break;

            case 'UserJoined':
                if (state.group) {
                    state.group.Participants = state.group.Participants || [];
                    if (state.group.Participants.indexOf(data) === -1) state.group.Participants.push(data);
                    SyncPlay.emit('group', state.group);
                    SyncPlay.emit('notice', data + ' joined the group');
                }
                break;

            case 'UserLeft':
                if (state.group && state.group.Participants) {
                    var index = state.group.Participants.indexOf(data);
                    if (index !== -1) state.group.Participants.splice(index, 1);
                    SyncPlay.emit('group', state.group);
                    SyncPlay.emit('notice', data + ' left the group');
                }
                break;

            case 'GroupDoesNotExist':
                U.toast('That SyncPlay group no longer exists');
                disable(true);
                break;

            case 'LibraryAccessDenied':
                U.toast('You do not have access to the group library');
                break;

            default:
                break;
        }
    }

    /* ------------------------------------------------------------ time sync */

    function recordMeasurement(offset, delay) {
        state.measurements.push({ offset: offset, delay: delay });
        if (state.measurements.length > 8) state.measurements.shift();

        var best = state.measurements[0];
        for (var i = 1; i < state.measurements.length; i++) {
            if (state.measurements[i].delay < best.delay) best = state.measurements[i];
        }
        state.timeOffset = best.offset;
    }

    function pingOnce() {
        var sent = new Date();
        return Api.serverTime().then(function (result) {
            var received = new Date();
            var requestReceived = parseDate(result && result.RequestReceptionTime);
            var responseSent = parseDate(result && result.ResponseTransmissionTime);
            if (!requestReceived || !responseSent) return;

            var offset = ((requestReceived.getTime() - sent.getTime()) +
                (responseSent.getTime() - received.getTime())) / 2;
            var delay = (received.getTime() - sent.getTime()) -
                (responseSent.getTime() - requestReceived.getTime());

            recordMeasurement(offset, delay);

            if (state.pings >= 3) state.pollInterval = 60000;
            else state.pings++;

            if (state.enabled) Api.syncPlayPing(delay / 2);

            if (!state.ready) {
                state.ready = true;
                if (state.queuedCommand) {
                    var queued = state.queuedCommand;
                    state.queuedCommand = null;
                    handleCommand(queued);
                }
            }

            SyncPlay.emit('timesync', state.timeOffset, delay / 2);
        }).catch(function () {
            SyncPlay.emit('timesync', state.timeOffset, 0);
        });
    }

    function schedulePing() {
        if (pingStopped) return;
        if (pingTimer) clearTimeout(pingTimer);
        pingTimer = setTimeout(function () {
            pingOnce().then(schedulePing, schedulePing);
        }, state.pollInterval);
    }

    function startTimeSync() {
        pingStopped = false;
        state.pollInterval = 1000;
        state.pings = 0;
        if (pingTimer) clearTimeout(pingTimer);
        pingOnce().then(schedulePing, schedulePing);
    }

    function stopTimeSync() {
        pingStopped = true;
        if (pingTimer) { clearTimeout(pingTimer); pingTimer = null; }
    }

    /* --------------------------------------------------------------- queue */

    function queueLastUpdate() {
        var date = state.queue && parseDate(state.queue.LastUpdate);
        return date ? date.getTime() : 0;
    }

    function currentIndex() {
        return state.queue ? state.queue.PlayingItemIndex : -1;
    }

    function estimateStartTicks() {
        if (!state.queue) return 0;

        var remoteNow = localToRemote(new Date()).getTime();
        var lastUpdate = queueLastUpdate();

        if (state.lastCommand && state.lastCommand.EmittedAt &&
                state.lastCommand.EmittedAt.getTime() >= lastUpdate) {
            return state.lastCommand.PositionTicks +
                (remoteNow - state.lastCommand.When.getTime()) * TICKS_PER_MS;
        }

        var start = state.queue.StartPositionTicks || 0;
        if (lastUpdate) start += (remoteNow - lastUpdate) * TICKS_PER_MS;
        return start;
    }

    function handlePlayQueue(data) {
        if (!data) return;

        data.LastUpdate = parseDate(data.LastUpdate) || new Date();

        if (state.queue && data.LastUpdate.getTime() <= queueLastUpdate()) {
            return; /* stale update */
        }

        state.queue = data;
        state.playlist = data.Playlist || [];

        var index = data.PlayingItemIndex;
        var item = (index >= 0 && index < state.playlist.length) ? state.playlist[index] : null;
        var playlistItemId = item ? item.PlaylistItemId : null;

        var previousItemId = state.currentPlaylistItemId;
        state.currentPlaylistItemId = playlistItemId;

        SyncPlay.emit('queue', state.queue);

        if (!item) {
            SyncPlay.emit('empty');
            return;
        }

        var reason = data.Reason;
        var needsLoad = reason === 'NewPlaylist' ||
            reason === 'SetCurrentItem' ||
            reason === 'NextItem' ||
            reason === 'PreviousItem' ||
            (reason === 'RemoveItems' && playlistItemId !== previousItemId);

        if (needsLoad && state.following) {
            var startTicks = estimateStartTicks();
            SyncPlay.emit('load', {
                itemId: item.ItemId,
                playlistItemId: playlistItemId,
                startTicks: Math.max(0, startTicks),
                reason: reason
            });
        }
    }

    /* ---------------------------------------------------------- commands */

    function handleCommand(command) {
        if (!command) return;

        var when = parseDate(command.When);
        var emittedAt = parseDate(command.EmittedAt);

        if (!when || !emittedAt) return;
        if (!state.enabled) return;
        if (state.enabledAt && emittedAt.getTime() < state.enabledAt.getTime()) return;

        command.When = when;
        command.EmittedAt = emittedAt;
        command.PositionTicks = command.PositionTicks ? parseInt(command.PositionTicks, 10) : 0;

        if (!state.ready) {
            state.queuedCommand = command;
            return;
        }

        /* WebSocket delivery can reorder; an older command must never undo a
           newer one. */
        if (state.lastCommand && state.lastCommand.EmittedAt &&
                emittedAt.getTime() < state.lastCommand.EmittedAt.getTime()) {
            return;
        }

        state.lastCommand = command;
        resetDrift();
        restoreSpeed();

        if (!state.playbackActive) {
            SyncPlay.emit('command-no-player', command);
            return;
        }

        if (command.PlaylistItemId && command.PlaylistItemId !== state.currentPlaylistItemId &&
                command.Command !== 'Stop') {
            /* Never jump the local player to another item on a stale command. */
            return;
        }

        applyCommand(command);
    }

    function applyCommand(command) {
        clearCommandTimer();

        var whenLocal = remoteToLocal(command.When).getTime();
        var delay = whenLocal - Date.now();
        var positionMs = Math.round((command.PositionTicks || 0) / TICKS_PER_MS);

        function run(fn) {
            if (delay > 0) commandTimer = setTimeout(fn, delay);
            else fn();
        }

        SyncPlay.emit('command', command);

        /* Server rules this relies on: a Ready report while the group is NOT
           waiting is answered by re-sending the current command, so replying
           to Pause/Unpause with Ready (or with a seek-induced Buffering) makes
           the TV pause, resume and seek in a loop. Only a Seek command, which
           puts the group in Waiting, is acknowledged with Ready. */
        switch (command.Command) {
            case 'Unpause':
                run(function () {
                    /* Never report a rebuffer caused by resuming: the server
                       would answer it with another Unpause. */
                    quiet(2500);
                    /* A late command means the group has moved on since `When`. */
                    var late = Math.max(0, Date.now() - whenLocal);
                    var target = positionMs + late;
                    if (Math.abs(Player.getPosition() - target) > 400) {
                        Player.seekTo(target);
                    }
                    Player.resume();
                    syncTimer = setTimeout(function () { state.syncEnabled = true; }, 1500);
                });
                break;

            case 'Pause':
                run(function () {
                    quiet(2500);
                    Player.pause();
                    if (Math.abs(Player.getPosition() - positionMs) > 400) {
                        Player.seekTo(positionMs);
                    }
                });
                break;

            case 'Seek':
                run(function () {
                    quiet(2500);
                    Player.pause();
                    Player.seekTo(positionMs);
                    /* The group is Waiting after a Seek and expects Ready. */
                    setTimeout(function () { reportReady(true); }, 700);
                });
                break;

            case 'Stop':
                run(function () { SyncPlay.emit('stop'); });
                break;

            default:
                break;
        }
    }

    /* --------------------------------------------------------------- ready */

    function bufferBody() {
        return {
            When: localToRemote(new Date()).toISOString(),
            PositionTicks: U.msToTicks(Player.getPosition()),
            IsPlaying: !Player.isPaused(),
            PlaylistItemId: state.currentPlaylistItemId
        };
    }

    /* `force` is for moments the server is known to be waiting for us (after a
       Seek command, or when a playback has just started). Otherwise Ready is
       only sent while the group is Waiting. */
    function reportReady(force) {
        if (!state.enabled) return;
        if (force !== true && state.groupState !== 'Waiting') return;
        state.bufferingReported = false;
        Api.syncPlayReady(bufferBody());
    }

    function reportBuffering(isBuffering) {
        if (!state.enabled) return;
        if (isBuffering) {
            if (isQuiet()) return;
            state.bufferingReported = true;
            Api.syncPlayBuffering(bufferBody());
        } else if (state.bufferingReported) {
            /* Only owe a Ready when we told the group we were buffering. */
            reportReady(true);
        }
    }

    /* ---------------------------------------------------------- public API */

    SyncPlay.connect = function () {
        if (socket) return socket;
        socket = Api.openSocket({
            onMessage: handleMessage,
            onClose: function () { /* reconnect handled inside Api.openSocket */ }
        });
        return socket;
    };

    SyncPlay.disconnect = function () {
        if (socket) { socket.close(); socket = null; }
        clearCommandTimer();
        clearBufferingTimer();
        stopTimeSync();
        state.enabled = false;
        state.group = null;
        state.queue = null;
        state.playlist = [];
        state.ready = false;
    };

    function enable(groupInfo) {
        if (!groupInfo || !groupInfo.GroupId) return;

        if (state.enabled && state.group && state.group.GroupId === groupInfo.GroupId) {
            state.group = groupInfo;
            SyncPlay.emit('group', state.group);
            return;
        }

        state.group = groupInfo;
        state.enabled = true;
        state.ready = false;
        state.following = true;
        state.syncEnabled = false;
        state.lastCommand = null;
        state.queuedCommand = null;
        state.groupState = null;
        state.bufferingReported = false;
        state.quietUntil = 0;
        state.enabledAt = parseDate(groupInfo.LastUpdatedAt) || new Date();
        state.pings = 0;

        SyncPlay.emit('enabled', state.group);
        SyncPlay.emit('group', state.group);
        startTimeSync();
    }

    function disable(notify) {
        var wasEnabled = state.enabled;

        state.enabled = false;
        state.group = null;
        state.queue = null;
        state.playlist = [];
        state.currentPlaylistItemId = null;
        state.ready = false;
        state.following = true;
        state.lastCommand = null;
        state.queuedCommand = null;
        state.enabledAt = null;
        state.syncEnabled = false;
        state.groupState = null;
        state.bufferingReported = false;
        state.quietUntil = 0;
        state.localBuffering = false;
        state.lastHardSeek = 0;
        resetDrift();
        restoreSpeed();
        clearCommandTimer();
        clearBufferingTimer();
        stopTimeSync();

        if (wasEnabled) {
            SyncPlay.emit('disabled');
            if (notify) U.toast('Left SyncPlay group');
        }
    }

    SyncPlay.listGroups = function () { return Api.syncPlayList(); };

    SyncPlay.createGroup = function (name) {
        return Api.syncPlayNew(name).then(function (group) {
            enable(group);
            return group;
        });
    };

    SyncPlay.joinGroup = function (groupId) {
        return Api.syncPlayJoin(groupId).then(function () {
            /* GroupJoined arrives over the socket and calls enable(). */
            return true;
        });
    };

    SyncPlay.leaveGroup = function () {
        return Api.syncPlayLeave().then(function () {
            disable(true);
        }).catch(function () {
            disable(true);
        });
    };

    /* Called when the user starts something while in a group: the whole group
       follows the new queue. */
    SyncPlay.startGroupPlayback = function (itemId, startTicks) {
        return Api.syncPlaySetNewQueue([itemId], 0, startTicks || 0);
    };

    SyncPlay.playPause = function () {
        if (!state.enabled) {
            if (Player.isPaused()) Player.resume(); else Player.pause();
            return;
        }
        if (Player.isPaused()) {
            Api.syncPlayUnpause();
        } else {
            Api.syncPlayPause();
            Player.pause();
        }
    };

    SyncPlay.seekTo = function (positionTicks) {
        if (!state.enabled) {
            Player.seekTo(U.ticksToMs(positionTicks));
            return;
        }
        Api.syncPlaySeek(positionTicks);
    };

    SyncPlay.stop = function () {
        if (!state.enabled) return;
        Api.syncPlayStop();
    };

    SyncPlay.followGroupPlayback = function () {
        state.following = true;
        Api.syncPlaySetIgnoreWait(false);
    };

    SyncPlay.haltGroupPlayback = function () {
        state.following = false;
        Api.syncPlaySetIgnoreWait(true);
    };

    SyncPlay.setPlaybackActive = function (active) {
        state.playbackActive = !!active;
    };

    SyncPlay.onPlaybackStarted = function () {
        state.playbackActive = true;
        reportReady(true);
    };

    SyncPlay.onPlaybackStopped = function () {
        state.playbackActive = false;
    };

    SyncPlay.onBuffering = function (isBuffering) {
        state.localBuffering = !!isBuffering;
        /* A stall freezes the position, so samples taken around it are bogus. */
        resetDrift();

        if (isBuffering) {
            /* A paused player is not waiting to play: its buffer fill must not
               drag the group into Waiting (and then resume it). */
            if (Player.isPaused() || bufferingTimer || isQuiet()) return;
            bufferingTimer = setTimeout(function () {
                bufferingTimer = null;
                if (state.localBuffering) reportBuffering(true);
            }, BUFFERING_REPORT_MS);
            return;
        }

        if (bufferingTimer) { clearTimeout(bufferingTimer); bufferingTimer = null; }
        reportBuffering(false);
    };

    /* Seeks inside a group always arrive as Seek/Pause/Unpause commands, which
       acknowledge themselves. AVPlay also fires 'seeked' synchronously for our
       own corrective seeks, so reporting it would only provoke the server. */
    SyncPlay.onSeeked = function () {};

    /* Drift correction, called from the player's timeupdate (every 500 ms). */
    SyncPlay.syncTick = function (positionMs) {
        if (!state.enabled || !state.syncEnabled) return;

        var command = state.lastCommand;
        if (!command || command.Command !== 'Unpause') return;
        if (state.localBuffering || Player.isPaused()) return;

        var now = Date.now();
        if (now - state.lastSyncCheck < 500) return;
        state.lastSyncCheck = now;

        var remoteNow = localToRemote(new Date(now)).getTime();
        var expectedMs = (command.PositionTicks / TICKS_PER_MS) +
            (remoteNow - command.When.getTime());

        state.driftSamples.push(expectedMs - positionMs);
        if (state.driftSamples.length > DRIFT_SAMPLES) state.driftSamples.shift();
        if (state.driftSamples.length < DRIFT_SAMPLES) return;

        /* The median ignores the odd stale or jumpy sample. */
        var diff = median(state.driftSamples);
        state.lastDiff = diff;
        SyncPlay.emit('drift', diff);

        var avplay = Player.mode === 'avplay';
        var hardSeekMs = avplay ? HARD_SEEK_AVPLAY_MS : HARD_SEEK_HTML5_MS;

        if (Math.abs(diff) > hardSeekMs) {
            if (now - state.lastHardSeek < HARD_SEEK_COOLDOWN_MS) return;
            state.lastHardSeek = now;
            state.syncEnabled = false;
            resetDrift();
            quiet(4000);
            Player.seekTo(expectedMs);
            SyncPlay.emit('resync', diff);
            /* Let the rebuffer finish before measuring again. */
            syncTimer = setTimeout(function () { state.syncEnabled = true; }, 4000);
            return;
        }

        /* Smooth catch-up by playback rate. AVPlay only takes whole-number
           speeds, so a fractional rate there stutters instead of syncing; the
           HTML5 player handles it fine. */
        if (!avplay && Math.abs(diff) > 60) {
            var speed = U.clamp(1 + diff / 1000, 0.9, 1.1);
            state.syncEnabled = false;
            state.speedChanged = true;
            resetDrift();
            Player.setSpeed(speed);
            SyncPlay.emit('speed-sync', speed);
            syncTimer = setTimeout(function () {
                restoreSpeed();
                state.syncEnabled = true;
            }, 1000);
        }
    };

    SyncPlay.isEnabled = function () { return state.enabled; };
    SyncPlay.isReady = function () { return state.ready; };
    SyncPlay.getGroup = function () { return state.group; };
    SyncPlay.getQueue = function () { return state.queue; };
    SyncPlay.getPlaylist = function () { return state.playlist.slice(0); };
    SyncPlay.getCurrentPlaylistItemId = function () { return state.currentPlaylistItemId; };
    SyncPlay.getTimeOffset = function () { return state.timeOffset; };
    SyncPlay.getDrift = function () { return state.lastDiff; };
    SyncPlay.getCurrentItemId = function () {
        var index = currentIndex();
        if (index < 0 || index >= state.playlist.length) return null;
        return state.playlist[index].ItemId;
    };

    SyncPlay.reportReady = function () { reportReady(false); };
    SyncPlay.reportBuffering = reportBuffering;

    global.SyncPlay = SyncPlay;
})(window);
