/* ==========================================================================
   Profile pictures

   The browser resizes and re-encodes a picture before uploading it, which is
   convenient and strips EXIF, but it is also entirely under the caller's
   control. Nothing it says is believed here: the content type and the
   dimensions are read back out of the file's own header, and the size is
   measured. A caller that claims "image/png, 64x64" while sending a 4 MB
   something-else gets rejected on the bytes, not on the claim.

   Only three formats are accepted, all of which a browser renders natively and
   all of which carry their dimensions somewhere readable without decoding the
   image. That is the point of the shortlist — an SVG, for instance, is a
   document that can carry script, and has no business being a profile picture.
   ========================================================================== */
'use strict';

const db = require('../db');
const { HttpError } = require('../middleware');

/** Matches the CHECK constraint in 002_user_avatars.sql. */
const MAX_BYTES = 262144;          // 256 KiB
const MIN_DIMENSION = 16;
const MAX_DIMENSION = 1024;

/* --------------------------------------------------------------------------
   Reading a header

   Each reader returns { contentType, width, height } or null. They are
   deliberately strict: a file that is nearly a PNG is not a PNG.
   -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readPng(buffer) {
    // 8-byte signature, then the IHDR chunk: length, type, width, height.
    if (buffer.length < 24) return null;
    if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
    if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;

    return {
        contentType: 'image/png',
        width: buffer.readUInt32BE(16),
        height: buffer.readUInt32BE(20)
    };
}

function readWebp(buffer) {
    // RIFF container: "RIFF" <size> "WEBP" then a format chunk.
    if (buffer.length < 30) return null;
    if (buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
    if (buffer.toString('ascii', 8, 12) !== 'WEBP') return null;

    const chunk = buffer.toString('ascii', 12, 16);

    if (chunk === 'VP8X') {
        // Canvas size is stored minus one, as two 24-bit little-endian values.
        return {
            contentType: 'image/webp',
            width: (buffer.readUIntLE(24, 3)) + 1,
            height: (buffer.readUIntLE(27, 3)) + 1
        };
    }

    if (chunk === 'VP8 ') {
        // Lossy: a 3-byte start code, then 14 bits of width and of height.
        if (buffer[23] !== 0x9d || buffer[24] !== 0x01 || buffer[25] !== 0x2a) return null;
        return {
            contentType: 'image/webp',
            width: buffer.readUInt16LE(26) & 0x3fff,
            height: buffer.readUInt16LE(28) & 0x3fff
        };
    }

    if (chunk === 'VP8L') {
        // Lossless: signature byte, then 14 bits each, packed across 4 bytes.
        if (buffer[20] !== 0x2f) return null;
        const bits = buffer.readUInt32LE(21);
        return {
            contentType: 'image/webp',
            width: (bits & 0x3fff) + 1,
            height: ((bits >> 14) & 0x3fff) + 1
        };
    }

    return null;
}

function readJpeg(buffer) {
    // Start of Image, then a walk over the marker segments looking for a Start
    // of Frame, which is the only place the dimensions live.
    if (buffer.length < 4) return null;
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;

    let offset = 2;

    while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) return null;        // Not where a marker should be.

        const marker = buffer[offset + 1];

        // Padding and standalone markers carry no length field.
        if (marker === 0xff) { offset += 1; continue; }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }

        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) return null;

        // SOF0..SOF15, excluding the four that are not frame headers.
        const isFrameHeader = marker >= 0xc0 && marker <= 0xcf
            && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

        if (isFrameHeader) {
            return {
                contentType: 'image/jpeg',
                height: buffer.readUInt16BE(offset + 5),
                width: buffer.readUInt16BE(offset + 7)
            };
        }

        offset += 2 + length;
    }

    return null;
}

/** Identify an image from its bytes alone. Returns null if it is not one we take. */
function identify(buffer) {
    return readPng(buffer) || readJpeg(buffer) || readWebp(buffer);
}

/* --------------------------------------------------------------------------
   Accepting an upload
   -------------------------------------------------------------------------- */

/**
 * Turn a `data:` URL from the browser into bytes, rejecting anything that is
 * not a small image in one of the three formats.
 *
 * @param {string} dataUrl
 * @returns {{ buffer: Buffer, contentType: string, width: number, height: number }}
 */
function decodeUpload(dataUrl) {
    if (typeof dataUrl !== 'string' || !dataUrl) {
        throw new HttpError(400, 'No picture was supplied.', 'AVATAR_MISSING');
    }

    const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/i.exec(dataUrl.trim());
    if (!match) {
        throw new HttpError(400, 'That does not look like an image file.', 'AVATAR_MALFORMED');
    }

    // Reject on the encoded length before allocating, so an enormous string is
    // never decoded just to find out it is too big. Base64 is 4 bytes per 3.
    if (match[2].length > Math.ceil(MAX_BYTES / 3) * 4 + 4) {
        throw new HttpError(413, 'That picture is too large. The limit is 256 KB.', 'AVATAR_TOO_LARGE');
    }

    let buffer;
    try {
        buffer = Buffer.from(match[2], 'base64');
    } catch {
        throw new HttpError(400, 'That picture could not be read.', 'AVATAR_MALFORMED');
    }

    if (!buffer.length) {
        throw new HttpError(400, 'That picture is empty.', 'AVATAR_MALFORMED');
    }
    if (buffer.length > MAX_BYTES) {
        throw new HttpError(413, 'That picture is too large. The limit is 256 KB.', 'AVATAR_TOO_LARGE');
    }

    // The header is the authority, not the data: prefix the caller sent.
    const identified = identify(buffer);
    if (!identified) {
        throw new HttpError(
            415,
            'That file is not a JPEG, PNG or WebP image.',
            'AVATAR_UNSUPPORTED_TYPE'
        );
    }

    const { contentType, width, height } = identified;

    if (width < MIN_DIMENSION || height < MIN_DIMENSION) {
        throw new HttpError(400, `That picture is too small. The minimum is ${MIN_DIMENSION}x${MIN_DIMENSION}.`, 'AVATAR_TOO_SMALL');
    }
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
        throw new HttpError(400, `That picture is too big. The maximum is ${MAX_DIMENSION}x${MAX_DIMENSION}.`, 'AVATAR_TOO_LARGE');
    }

    return { buffer, contentType, width, height };
}

/** Store (or replace) an account's picture. */
async function save(userId, dataUrl, uploadedBy) {
    const { buffer, contentType, width, height } = decodeUpload(dataUrl);

    await db.execute(
        `INSERT INTO user_avatars (user_id, image_bytes, content_type, byte_size, width, height, uploaded_by, uploaded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE
            SET image_bytes  = EXCLUDED.image_bytes,
                content_type = EXCLUDED.content_type,
                byte_size    = EXCLUDED.byte_size,
                width        = EXCLUDED.width,
                height       = EXCLUDED.height,
                uploaded_by  = EXCLUDED.uploaded_by,
                uploaded_at  = now()`,
        [userId, buffer, contentType, buffer.length, width, height, uploadedBy]
    );

    return { contentType, width, height, byteSize: buffer.length };
}

async function remove(userId) {
    return db.execute('DELETE FROM user_avatars WHERE user_id = $1', [userId]);
}

/**
 * Read one back as a `data:` URL.
 *
 * A URL would be the obvious thing, but the browser does not attach the bearer
 * token to an <img src>, and the content security policy already allows
 * `data:` — so the picture travels inside the authenticated JSON response that
 * asked for it, and no separate unauthenticated image route has to exist.
 */
async function asDataUrl(userId) {
    const row = await db.queryOne(
        'SELECT image_bytes, content_type FROM user_avatars WHERE user_id = $1',
        [userId]
    );
    if (!row) return null;

    return `data:${row.contentType};base64,${row.imageBytes.toString('base64')}`;
}

/** Which of these accounts have a picture, and when it last changed. */
async function summaryFor(userIds) {
    if (!userIds.length) return new Map();

    const rows = await db.query(
        'SELECT user_id, uploaded_at FROM user_avatars WHERE user_id = ANY($1::bigint[])',
        [userIds]
    );
    return new Map(rows.map(r => [String(r.userId), r.uploadedAt]));
}

module.exports = {
    MAX_BYTES,
    MIN_DIMENSION,
    MAX_DIMENSION,
    identify,
    decodeUpload,
    save,
    remove,
    asDataUrl,
    summaryFor
};
