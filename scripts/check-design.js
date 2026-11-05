#!/usr/bin/env node
/* Fails when a stylesheet uses a colour that DESIGN.md does not define.
   Tizen 3.0 has no CSS variables, so tokens are literals; this keeps them honest.
     node scripts/check-design.js */
'use strict';

var fs = require('fs');
var path = require('path');

var ROOT = path.resolve(__dirname, '..');
var design = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8');
var front = design.split('---')[1] || '';

var hexes = {};
(front.match(/#[0-9a-fA-F]{6}\b/g) || []).forEach(function (h) { hexes[h.toLowerCase()] = true; });
hexes['#000'] = true;
hexes['#fff'] = true;

/* rgba() literals must be built from a token's channels (alpha is free). */
var channels = { '0,0,0': true };
Object.keys(hexes).forEach(function (h) {
    if (h.length !== 7) return;
    channels[[1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16); }).join(',')] = true;
});

var bad = [];
['css/app.css', 'css/fonts.css'].forEach(function (file) {
    var text = fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    text.split('\n').forEach(function (line, i) {
        (line.match(/#[0-9a-fA-F]{3,8}\b/g) || []).forEach(function (h) {
            if (!hexes[h.toLowerCase()]) bad.push(file + ':' + (i + 1) + ' ' + h);
        });
        (line.match(/rgba?\([^)]*\)/g) || []).forEach(function (c) {
            var n = c.replace(/rgba?\(|\)|\s/g, '').split(',').slice(0, 3).join(',');
            if (!channels[n]) bad.push(file + ':' + (i + 1) + ' ' + c);
        });
        if (/hsl\(/.test(line)) bad.push(file + ':' + (i + 1) + ' hsl()');
    });
});

if (bad.length) {
    console.error('Colours not in DESIGN.md:\n  ' + bad.join('\n  '));
    process.exit(1);
}
console.log('check-design: all colour literals match DESIGN.md');
