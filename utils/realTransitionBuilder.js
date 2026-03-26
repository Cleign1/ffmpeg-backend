import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { CONFIG } from "../config.js";

const ensureTempDir = async () => {
  await fsp.mkdir(CONFIG.TEMP_DIR, { recursive: true });
};

/**
 * Build a rendered preview (MP3) for the given playlist items.
 * Each item can provide:
 * - id (string): identifies the audio file (expected to be stored as SONGS_DIR/<id>.mp3 or .m4a)
 * - modifiedSettings: { cut_in, cut_out, mix_point } in seconds
 *
 * Logic:
 * - atrim to cut_in/cut_out
 * - asetpts to reset timestamps
 * - afade in/out (1s default; capped to track duration)
 * - adelay to position on global timeline (ms)
 * - amix to combine all into single output
 */
const slicePlayableWindow = (items, limitSeconds = 90) => {
  if (!Array.isArray(items)) return [];
  let acc = 0;
  const trimmed = [];
  for (const item of items) {
    if (acc >= limitSeconds) break;
    const settings = item.modifiedSettings || {};
    const cutIn = Number(settings.cut_in ?? 0);
    const cutOut = Number(
      settings.cut_out ??
        (settings.duration !== undefined
          ? settings.duration
          : settings.cut_in !== undefined
            ? settings.cut_in
            : 0),
    );
    const mixPoint = Number(
      settings.mix_point ??
        (settings.cut_out ?? settings.duration ?? settings.cut_in ?? cutOut),
    );
    const safeCutOut = Math.max(cutIn, cutOut);
    const playableDuration = Math.max(0, safeCutOut - cutIn);
    const overlapStart = Math.max(0, mixPoint - cutIn);
    const projectedEnd = acc + overlapStart;
    if (projectedEnd >= limitSeconds) break;

    trimmed.push({
      ...item,
      modifiedSettings: {
        ...settings,
        cut_in: cutIn,
        cut_out: safeCutOut,
        mix_point: mixPoint,
      },
    });
    acc = projectedEnd;
  }
  return trimmed.length ? trimmed : items.slice(0, 1);
};

export const buildRealMusicBed = async (
  playlistItems = [],
  outputPath,
  { limitSeconds = 90 } = {},
) => {
  if (!Array.isArray(playlistItems) || playlistItems.length === 0) {
    throw new Error("No playlist items provided");
  }

  const scopedItems = slicePlayableWindow(playlistItems, limitSeconds);

  await ensureTempDir();

  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    const filterComplex = [];
    const mixInputs = [];
    let aborted = false;

    let timelineSeconds = 0;

    scopedItems.forEach((item, index) => {
      if (aborted) return;
      const settings = item.modifiedSettings || {};
      const cutIn = Number(settings.cut_in ?? 0);
      const cutOut = Number(
        settings.cut_out ??
          (settings.duration !== undefined
            ? settings.duration
            : settings.cut_in !== undefined
              ? settings.cut_in
              : 0),
      );
      const mixPoint = Number(
        settings.mix_point ??
          (settings.cut_out ?? settings.duration ?? settings.cut_in ?? cutOut),
      );

      const safeCutOut = Math.max(cutIn, cutOut);
    const playableDuration = Math.max(0, safeCutOut - cutIn);

    const startAt =
      typeof item.start_at === "number"
        ? Number(item.start_at)
        : typeof item.start === "number"
          ? Number(item.start)
          : 0;
    const advanceTimeline = item.advanceTimeline !== false;

      // Select file by id; prefer mp3 then m4a
      const baseName = item.filename || item.fileName || item.id;
      const stripExt = (p) => p?.replace(/\.(mp3|m4a|wav)$/i, "");
      const candidates = [
        baseName ? path.join(CONFIG.SONGS_DIR, baseName) : null,
        stripExt(baseName) ? path.join(CONFIG.SONGS_DIR, `${stripExt(baseName)}.mp3`) : null,
        stripExt(baseName) ? path.join(CONFIG.SONGS_DIR, `${stripExt(baseName)}.m4a`) : null,
        stripExt(baseName) ? path.join(CONFIG.SONGS_DIR, `${stripExt(baseName)}.wav`) : null,
        path.join(CONFIG.SONGS_DIR, `${item.id}.mp3`),
        path.join(CONFIG.SONGS_DIR, `${item.id}.m4a`),
      ].filter(Boolean);
      const chosenPath = candidates.find((p) => fs.existsSync(p));

      if (!chosenPath) {
        if (!aborted) reject(new Error(`Source audio not found for id ${item.id}`));
        aborted = true;
        return;
      }

    command.input(chosenPath);

    // Per-track gain (ducking)
    const gainFilter =
      typeof item.gainDb === "number" && item.gainDb !== 0
        ? `,volume=${Math.pow(10, item.gainDb / 20).toFixed(4)}`
        : "";
    const voiceGain =
      typeof item.voiceGain === "number" && item.voiceGain > 0
        ? `,volume=${item.voiceGain}`
        : "";
    const env = item.envelope || null;

      const label = `[aud${index}]`;
    let chain = `[${index}:a]atrim=start=${cutIn}:end=${safeCutOut},asetpts=PTS-STARTPTS`;

      const fadeDur = Math.min(1, playableDuration > 0 ? playableDuration / 4 : 0); // graceful fade default 1s
      if (fadeDur > 0) {
        chain += `,afade=t=in:st=0:d=${fadeDur}`;
        const fadeOutStart = Math.max(0, playableDuration - fadeDur);
        chain += `,afade=t=out:st=${fadeOutStart}:d=${fadeDur}`;
      }

    const baseTimeline = advanceTimeline ? timelineSeconds : 0;
    const delayMs = Math.max(0, Math.round((baseTimeline + startAt) * 1000));
    if (delayMs > 0) {
      chain += `,adelay=${delayMs}|${delayMs}`;
    }

    if (env && env.voiceEndSec !== undefined) {
      const gStart = Number(env.gainStart ?? 0.4);
      const gTarget = Number(env.gainTarget ?? 0.9);
      const rampDelay = Number(env.rampDelaySec ?? 0);
      const rampDur = Number(env.rampDurSec ?? 0.5) || 0.001;
      const voiceEnd = Number(env.voiceEndSec ?? 0);
      const rampStart = voiceEnd + rampDelay;
      const endRamp = rampStart + rampDur;
      // Hold duck during voice, hold until ramp start, then ramp to target and hold
      chain +=
        `,volume='if(lt(t,${voiceEnd.toFixed(3)}),${gStart.toFixed(3)},` +
        ` if(lt(t,${rampStart.toFixed(3)}),${gStart.toFixed(3)},` +
        ` if(lt(t,${endRamp.toFixed(3)}),${gStart.toFixed(3)} + ((t-${rampStart.toFixed(3)})/${rampDur.toFixed(3)})*${(gTarget - gStart).toFixed(4)},` +
        ` ${gTarget.toFixed(3)})))'`;
    } else if (voiceGain) {
      chain += voiceGain;
    } else if (gainFilter) {
      chain += gainFilter;
    }

    chain += label;
    filterComplex.push(chain);
    mixInputs.push(label);

    const overlapStart = Math.max(0, mixPoint - cutIn);
    if (advanceTimeline) {
      timelineSeconds += overlapStart;
    }
  });

    if (aborted || mixInputs.length === 0) {
      reject(new Error("No valid inputs to render"));
      return;
    }

    const mixFilter = `${mixInputs.join("")}amix=inputs=${mixInputs.length}:duration=longest[out]`;
    filterComplex.push(mixFilter);

    command
      .complexFilter(filterComplex)
      .outputOptions("-map [out]")
      .audioCodec("libmp3lame")
      .audioBitrate("192k")
      .on("end", () => resolve(outputPath))
      .on("error", (err) => reject(err))
      .save(outputPath);
  });
};
