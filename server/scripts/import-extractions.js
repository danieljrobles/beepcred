#!/usr/bin/env node
/**
 * Import auto-ready plate extractions into BeepCred.
 *
 * Usage:
 *   node server/scripts/import-extractions.js \
 *     --plan /path/to/import-plan.json \
 *     [--source-root /path/to/Photos-1-001] \
 *     [--dry-run]
 *
 * If --source-root is set, photo paths are remapped to
 *   <source-root>/<basename(original path)>
 */
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sequelize, User, LicensePlate, PlateImage } = require('../db');
const {
  buildSlug,
  normalizePlateNumber,
  normalizeDisplayPlateText,
  normalizeState,
} = require('../lib/plateUtils');
const { normalizePlateTypes, mergePlateTypes } = require('../lib/plateTypes');
const { processPlateImage } = require('../lib/imageProcess');
const { platesDir, thumbsDir } = require('../middleware/uploadPlate');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  if (i === -1) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function resolvePhotoPath(originalPath, sourceRoot) {
  if (!sourceRoot) return originalPath;
  return path.join(sourceRoot, path.basename(originalPath));
}

async function getImporterUser() {
  const preferred =
    (await User.findOne({ where: { email: 'danieljrobles@gmail.com' } })) ||
    (await User.findOne({ where: { username: 'danieljrobles' } })) ||
    (await User.findOne({ where: { username: 'admin' } })) ||
    (await User.findOne({ order: [['created_at', 'ASC']] }));
  if (!preferred) throw new Error('No users exist. Seed or sign in once first.');
  return preferred;
}

function platePayload(row) {
  const state = normalizeState(row.state);
  const plate_number = normalizePlateNumber(row.plate_number);
  const country = String(row.country || 'US').toUpperCase().slice(0, 8);
  return {
    state,
    plate_number,
    country,
    display_plate_text: normalizeDisplayPlateText(row.display_plate_text || row.plate_number),
    make: row.make || null,
    model: row.model || null,
    year: row.year ? parseInt(row.year, 10) : null,
    color: row.color || null,
    body_type: row.body_type || 'other',
    plate_types: normalizePlateTypes(row.plate_types),
    slug: buildSlug(state, plate_number),
  };
}

async function upsertPlate(payload, { fillVehicleMeta }) {
  const now = new Date();
  let plate = await LicensePlate.findOne({
    where: {
      plate_number: payload.plate_number,
      state: payload.state,
      country: payload.country,
    },
  });
  let created = false;
  if (!plate) {
    plate = await LicensePlate.create({
      ...payload,
      first_seen_at: now,
      last_seen_at: now,
    });
    created = true;
    return { plate, created };
  }

  if (fillVehicleMeta) {
    const updates = {};
    if (!plate.display_plate_text && payload.display_plate_text) {
      updates.display_plate_text = payload.display_plate_text;
    }
    for (const field of ['make', 'model', 'year', 'color', 'body_type']) {
      if (!plate[field] && payload[field]) updates[field] = payload[field];
    }
    if (payload.plate_types?.length) {
      const merged = mergePlateTypes(plate.getDataValue('plate_types'), payload.plate_types);
      const current = normalizePlateTypes(plate.plate_types);
      if (JSON.stringify(merged) !== JSON.stringify(current)) {
        updates.plate_types = merged;
      }
    }
    if (Object.keys(updates).length) await plate.update(updates);
  }
  return { plate, created };
}

async function attachPhoto(plate, photo, uploaderId, dryRun) {
  const filename = photo.filename || path.basename(photo.path);
  const existing = await PlateImage.findOne({
    where: { plate_id: plate.id, original_filename: filename },
  });
  if (existing) return { status: 'skipped_duplicate', filename };

  if (dryRun) return { status: 'would_upload', filename };

  if (!fs.existsSync(photo.path)) {
    return { status: 'missing_file', filename, path: photo.path };
  }

  const baseId = crypto.createHash('sha1').update(`${plate.id}:${filename}`).digest('hex').slice(0, 12);
  const processed = await processPlateImage(photo.path, baseId, platesDir, thumbsDir);
  const shot =
    photo.shot_type && ['plate', 'front', 'rear', 'side', 'interior', 'other'].includes(photo.shot_type)
      ? photo.shot_type
      : 'plate';

  const img = await PlateImage.create({
    plate_id: plate.id,
    uploaded_by: uploaderId,
    image_url: processed.image_url,
    thumbnail_url: processed.thumbnail_url,
    original_filename: filename,
    file_size_bytes: processed.file_size_bytes,
    width: processed.width,
    height: processed.height,
    caption: photo.vehicle_notes ? String(photo.vehicle_notes).slice(0, 500) : null,
    shot_type: shot,
    is_primary: !plate.primary_image_id,
    is_approved: true,
    uploaded_at: new Date(),
  });

  const updates = {
    last_seen_at: new Date(),
    post_count: (plate.post_count || 0) + 1,
  };
  if (!plate.primary_image_id) updates.primary_image_id = img.id;
  await plate.update(updates);
  return { status: 'uploaded', filename, image_id: img.id };
}

async function run() {
  const planPath = arg('--plan');
  const sourceRoot = arg('--source-root');
  const dryRun = hasFlag('--dry-run');
  if (!planPath) {
    throw new Error('Usage: node server/scripts/import-extractions.js --plan import-plan.json [--source-root DIR] [--dry-run]');
  }

  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  const uploader = await getImporterUser();
  console.log(
    JSON.stringify({
      dryRun,
      uploader: { id: uploader.id, username: uploader.username },
      unique_plates: plan.unique_plates,
      auto_rows: plan.auto_rows,
      sourceRoot,
    })
  );

  const report = {
    plates_created: 0,
    plates_reused: 0,
    additional_created: 0,
    additional_reused: 0,
    photos_uploaded: 0,
    photos_skipped_duplicate: 0,
    photos_missing: 0,
    photos_failed: 0,
    failures: [],
  };

  for (const row of plan.plates) {
    const payload = platePayload(row);
    if (!payload.state || payload.state.length !== 2 || !payload.plate_number) {
      report.failures.push({ key: row.key, error: 'invalid state/plate_number' });
      continue;
    }

    try {
      if (dryRun) {
        console.log(`[dry-run] plate ${payload.state} ${payload.plate_number} photos=${row.photos.length}`);
      }
      const { plate, created } = dryRun
        ? { plate: { id: 'dry-run', primary_image_id: null, post_count: 0 }, created: true }
        : await upsertPlate(payload, { fillVehicleMeta: true });
      if (created) report.plates_created += 1;
      else report.plates_reused += 1;

      for (const photo of row.photos) {
        const resolved = {
          ...photo,
          path: resolvePhotoPath(photo.path, sourceRoot),
        };
        try {
          const result = await attachPhoto(plate, resolved, uploader.id, dryRun);
          if (result.status === 'uploaded' || result.status === 'would_upload') report.photos_uploaded += 1;
          else if (result.status === 'skipped_duplicate') report.photos_skipped_duplicate += 1;
          else if (result.status === 'missing_file') {
            report.photos_missing += 1;
            report.failures.push({ key: row.key, ...result });
          }
        } catch (err) {
          report.photos_failed += 1;
          report.failures.push({
            key: row.key,
            filename: photo.filename,
            error: err.message,
          });
        }
      }

      for (const extra of row.additional_plates || []) {
        const extraPayload = platePayload(extra);
        if (!extraPayload.state || !extraPayload.plate_number) continue;
        if (dryRun) {
          report.additional_created += 1;
          continue;
        }
        const { created: extraCreated } = await upsertPlate(extraPayload, { fillVehicleMeta: false });
        if (extraCreated) report.additional_created += 1;
        else report.additional_reused += 1;
      }
    } catch (err) {
      report.failures.push({ key: row.key, error: err.message });
    }
  }

  console.log(JSON.stringify(report, null, 2));
  await sequelize.close();
  if (report.failures.length && !dryRun) process.exitCode = 1;
}

run().catch(async (err) => {
  console.error(err);
  try {
    await sequelize.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
