/**
 * Profile picture validation.
 *
 * The browser resizes and re-encodes before uploading, but nothing it sends is
 * trusted: the type and the dimensions are read back out of the file's own
 * header. These tests are about what happens when the bytes and the claim
 * disagree — which is the only case that matters, because a well-behaved client
 * is not the threat.
 *
 * No database and no network: this is the pure decode path.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const avatars = require('../server/services/avatars');

/* --------------------------------------------------------------------------
   Fixtures

   Built byte by byte rather than pasted as base64 blobs, so what each one
   asserts is visible: a PNG is a signature plus an IHDR carrying big-endian
   dimensions, and so on.
   -------------------------------------------------------------------------- */

function pngOf(width, height) {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);            // IHDR length
    header.write('IHDR', 12, 'ascii');
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return Buffer.concat([header, Buffer.alloc(64)]);
}

function jpegOf(width, height) {
    // SOI, then a JFIF APP0 to be walked over, then an SOF0 carrying the size.
    const app0 = Buffer.concat([
        Buffer.from([0xff, 0xe0]),
        (() => { const b = Buffer.alloc(2); b.writeUInt16BE(16); return b; })(),
        Buffer.alloc(14)
    ]);
    const sof = Buffer.alloc(11);
    sof.writeUInt8(0xff, 0);
    sof.writeUInt8(0xc0, 1);                // SOF0
    sof.writeUInt16BE(11, 2);               // segment length
    sof.writeUInt8(8, 4);                   // sample precision
    sof.writeUInt16BE(height, 5);
    sof.writeUInt16BE(width, 7);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.alloc(32)]);
}

function webpOf(width, height) {
    // RIFF/WEBP with a VP8X chunk, whose canvas size is stored minus one.
    const buffer = Buffer.alloc(40);
    buffer.write('RIFF', 0, 'ascii');
    buffer.writeUInt32LE(32, 4);
    buffer.write('WEBP', 8, 'ascii');
    buffer.write('VP8X', 12, 'ascii');
    buffer.writeUInt32LE(10, 16);
    buffer.writeUIntLE(width - 1, 24, 3);
    buffer.writeUIntLE(height - 1, 27, 3);
    return buffer;
}

const asDataUrl = (buffer, declared) => `data:${declared};base64,${buffer.toString('base64')}`;

/* -------------------------------------------------------------------------- */

test('reads the real dimensions out of each supported format', () => {
    for (const [label, buffer, expected] of [
        ['png', pngOf(512, 512), { contentType: 'image/png', width: 512, height: 512 }],
        ['jpeg', jpegOf(640, 480), { contentType: 'image/jpeg', width: 640, height: 480 }],
        ['webp', webpOf(256, 128), { contentType: 'image/webp', width: 256, height: 128 }]
    ]) {
        assert.deepEqual(avatars.identify(buffer), expected, `${label} header misread`);
    }
});

test('a JPEG is read past its metadata segments, not from a fixed offset', () => {
    // The dimensions live in the SOF, which sits after however many APP
    // segments the encoder chose to write. Reading at a fixed offset would
    // appear to work on one encoder's output and fail on another's.
    const identified = avatars.identify(jpegOf(321, 123));
    assert.equal(identified.width, 321);
    assert.equal(identified.height, 123);
});

test('the declared type is ignored; the bytes decide', () => {
    // A PNG announced as a JPEG is still stored as a PNG. The claim is not an
    // input to the decision, so lying about it achieves nothing.
    const { contentType, width } = avatars.decodeUpload(asDataUrl(pngOf(64, 64), 'image/jpeg'));
    assert.equal(contentType, 'image/png');
    assert.equal(width, 64);
});

test('rejects anything that is not one of the three formats', () => {
    for (const [label, payload] of [
        ['an SVG, which can carry script', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')],
        ['a GIF', Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32)])],
        ['plain text wearing an image type', Buffer.from('this is not an image at all')],
        ['a PDF', Buffer.concat([Buffer.from('%PDF-1.7', 'ascii'), Buffer.alloc(32)])]
    ]) {
        assert.throws(
            () => avatars.decodeUpload(asDataUrl(payload, 'image/png')),
            (err) => err.code === 'AVATAR_UNSUPPORTED_TYPE',
            `${label} was accepted`
        );
    }
});

test('rejects a truncated header rather than reading past the end', () => {
    // Every reader is given fewer bytes than its header needs.
    for (const buffer of [pngOf(64, 64).subarray(0, 20), webpOf(64, 64).subarray(0, 18), Buffer.from([0xff, 0xd8])]) {
        assert.throws(
            () => avatars.decodeUpload(asDataUrl(buffer, 'image/png')),
            (err) => err.code === 'AVATAR_UNSUPPORTED_TYPE'
        );
    }
});

test('rejects a picture larger than the column will hold', () => {
    const oversized = Buffer.concat([pngOf(512, 512), Buffer.alloc(avatars.MAX_BYTES + 1)]);
    assert.throws(
        () => avatars.decodeUpload(asDataUrl(oversized, 'image/png')),
        (err) => err.code === 'AVATAR_TOO_LARGE'
    );
});

test('rejects dimensions outside what the schema allows', () => {
    assert.throws(
        () => avatars.decodeUpload(asDataUrl(pngOf(8, 8), 'image/png')),
        (err) => err.code === 'AVATAR_TOO_SMALL',
        'an 8px image was accepted'
    );
    assert.throws(
        () => avatars.decodeUpload(asDataUrl(pngOf(4000, 4000), 'image/png')),
        (err) => err.code === 'AVATAR_TOO_LARGE',
        'a 4000px image was accepted'
    );
});

test('rejects malformed or missing input', () => {
    for (const [label, value] of [
        ['empty string', ''],
        ['null', null],
        ['a number', 42],
        ['a bare URL', 'https://example.com/photo.jpg'],
        ['a data URL with no base64 marker', 'data:image/png,notbase64'],
        ['base64 with characters outside the alphabet', 'data:image/png;base64,!!!!']
    ]) {
        assert.throws(
            () => avatars.decodeUpload(value),
            (err) => ['AVATAR_MISSING', 'AVATAR_MALFORMED'].includes(err.code),
            `${label} was accepted`
        );
    }
});

test('the accepted size agrees with the database constraint', () => {
    // 002_user_avatars.sql caps byte_size at 256 KiB. If one moves without the
    // other, uploads start failing at the database instead of with a message.
    assert.equal(avatars.MAX_BYTES, 262144);
    assert.equal(avatars.MIN_DIMENSION, 16);
    assert.equal(avatars.MAX_DIMENSION, 1024);
});
