import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import os from 'os';
import { parseFile } from 'music-metadata'; // <--- NEW IMPORT

// Helper to simulate logs
const log = (msg) => console.log(`[ANALYZER] ${msg}`);

/**
 * Analyzes audio to find markers AND extracts metadata.
 */
export async function analyzeAudio(inputFilePath, filename, silenceLevel = 5000, mixLevel = 90) {
    const tempId = Date.now();
    const safeFilename = path.basename(filename).replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const tempTxtPath = path.join(os.tmpdir(), `${safeFilename}-${tempId}.txt`);
    
    // Ensure 'ffmpeg' is in your PATH
    const ffmpegPath = 'ffmpeg'; 
    
    log(`Analyzing: ${filename}...`);
    
    try {
        // --- 1. EXTRACT ID3 METADATA ---
        let songTags = {
            title: filename, // Fallback
            artist: 'Unknown Artist',
            genre: 'Unknown',
            duration: 0
        };

        try {
            const metadata = await parseFile(inputFilePath);
            songTags = {
                title: metadata.common.title || filename,
                artist: metadata.common.artist || 'Unknown Artist',
                genre: metadata.common.genre ? metadata.common.genre[0] : 'Music',
                duration: metadata.format.duration || 0
            };
        } catch (err) {
            console.warn(`[WARN] Could not read ID3 tags for ${filename}`);
        }

        // --- 2. RUN FFMPEG ASTATS (MARKER DETECTION) ---
        const analyzeCommand = `${ffmpegPath} -y -i "${inputFilePath}" -af "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file='${tempTxtPath}'" -f null -`;

        await new Promise((resolve) => {
            exec(analyzeCommand, (error) => {
                if (error) console.error(`FFmpeg Error: ${error.message}`);
                resolve(); 
            });
        });

        if (fs.existsSync(tempTxtPath)) {
            const fileContent = fs.readFileSync(tempTxtPath, 'utf-8');
            let lines = fileContent.split(/\r?\n/).filter(l => l.trim() !== '');
            let linesArray = [];
            
            // Parse Levels
            for (let i = 0; i < lines.length - 1; i += 2) {
                let timeLine = lines[i];
                let timeMatch = timeLine.match(/pts_time:([\d\.]+)/);
                if (!timeMatch) continue;
                let ptsMs = Math.floor(1000 * parseFloat(timeMatch[1]));

                let levelLine = lines[i+1];
                let levelMatch = levelLine.match(/RMS_level=([-\d\.inf]+)/);
                if (!levelMatch) continue;
                
                let rawLevel = levelMatch[1];
                let lvl = (rawLevel === '-inf') ? -100 : parseFloat(rawLevel);
                
                let levelbcn = Math.floor(lvl * 100) + 10000;
                if (levelbcn < 0) levelbcn = 0;

                linesArray.push({ "pts": ptsMs, "level": levelbcn });
            }

            if (linesArray.length === 0) throw new Error("Parsing failed (no data found).");

            let t0 = linesArray[0].pts;
            let t1 = linesArray[linesArray.length - 1].pts;
            let audioLength = t1 + (t1 - t0);

            // --- MARKER ALGORITHMS (Standard Logic) ---
            let maxLevel = silenceLevel;
            for (let i = 0; i < linesArray.length; i++) {
                if (maxLevel < linesArray[i].level) maxLevel = linesArray[i].level;
            }

            let silenceBreakValue = silenceLevel + 1500;

            // Find Cut-In
            let cit1 = linesArray[0].pts; let cil1 = linesArray[0].level;
            let cit2 = linesArray[0].pts; let cil2 = linesArray[0].level;
            let cit3 = linesArray[0].pts; let cil3 = linesArray[0].level;
            let cit4 = linesArray[0].pts; let cil4 = linesArray[0].level;
            let resultCutIn = { "level": cil1, "time": cit1 };
            let cutInFound = false;
            let iCutIn = 0;

            for (let i = 0; i < linesArray.length; i++) {
                if (cil2 > silenceLevel && cil3 > silenceLevel && cil4 > silenceLevel) {
                    if (!cutInFound) { resultCutIn = { "level": cil1, "time": cit1 }; cutInFound = true; }
                }
                if (cutInFound && (cil2 < silenceLevel || cil3 < silenceLevel || cil4 < silenceLevel)) { cutInFound = false; }
                if (cutInFound && (cil1 > silenceBreakValue || cil2 > silenceBreakValue || cil3 > silenceBreakValue || cil4 > silenceBreakValue)) { iCutIn = i; break; }
                cil1 = cil2; cit1 = cit2; cil2 = cil3; cit2 = cit3; cil3 = cil4; cit3 = cit4;
                cil4 = linesArray[i].level; cit4 = linesArray[i].pts;
            }

            // Find Cut-Out
            let lastIdx = linesArray.length - 1;
            let cot1 = linesArray[lastIdx].pts; let col1 = linesArray[lastIdx].level;
            let cot2 = linesArray[lastIdx].pts; let col2 = linesArray[lastIdx].level;
            let cot3 = linesArray[lastIdx].pts; let col3 = linesArray[lastIdx].level;
            let cot4 = linesArray[lastIdx].pts; let col4 = linesArray[lastIdx].level;
            let resultCutOut = { "level": col1, "time": cot1 };
            let cutOutFound = false;
            let iCutOut = lastIdx;

            for (let i = lastIdx; i >= 0; i--) {
                if (col2 > silenceLevel && col3 > silenceLevel && col4 > silenceLevel) {
                    if (!cutOutFound) { resultCutOut = { "level": col1, "time": cot1 }; cutOutFound = true; }
                }
                if (cutOutFound && (col2 < silenceLevel || col3 < silenceLevel || col4 < silenceLevel)) { cutOutFound = false; }
                if (cutOutFound && (col1 > silenceBreakValue || col2 > silenceBreakValue || col3 > silenceBreakValue || col4 > silenceBreakValue)) { iCutOut = i; break; }
                col1 = col2; cot1 = cot2; col2 = col3; cot2 = cot3; col3 = col4; cot3 = cot4;
                col4 = linesArray[i].level; cot4 = linesArray[i].pts;
            }

            // Mix Points
            let maxLevelBegin = silenceLevel;
            let mixPointBeginMaxTime = (mixLevel === 88) ? audioLength : 2000;
            for (let i = 0; i < linesArray.length; i++) {
                if (linesArray[i].pts >= resultCutIn.time && linesArray[i].level > maxLevelBegin) maxLevelBegin = linesArray[i].level;
                if ((linesArray[i].pts - resultCutIn.time) >= mixPointBeginMaxTime) break;
            }
            let resultMixPointBegin = { "level": resultCutIn.level, "time": resultCutIn.time };
            let mixPointLevelBegin = silenceLevel + ((maxLevelBegin - silenceLevel) * (mixLevel / 100));
            for (let i = 0; i < linesArray.length; i++) {
                if (linesArray[i].pts >= resultCutIn.time && linesArray[i].level > mixPointLevelBegin) {
                    resultMixPointBegin = { "level": linesArray[i].level, "time": linesArray[i].pts };
                    break;
                }
                if ((linesArray[i].pts - resultCutIn.time) >= mixPointBeginMaxTime) break;
            }

            let maxLevelEnd = silenceLevel;
            let mixPointEndMaxTime = 5000;
            if ((resultCutOut.time - resultCutIn.time) <= 65000) mixPointEndMaxTime = 3000;
            if ((resultCutOut.time - resultCutIn.time) <= 35000) mixPointEndMaxTime = 2000;
            let maxLevelMaxTime = silenceLevel; 
            let mixPointEndMaxTimeFound = false;
            for (let i = lastIdx; i >= 0; i--) {
                if (linesArray[i].pts <= resultCutOut.time && linesArray[i].level > maxLevelEnd) maxLevelEnd = linesArray[i].level;
                if ((resultCutOut.time - linesArray[i].pts) >= mixPointEndMaxTime && !mixPointEndMaxTimeFound && linesArray[i].level > maxLevelMaxTime) {
                    maxLevelMaxTime = linesArray[i].level;
                    mixPointEndMaxTimeFound = true;
                }
            }
            let mixPointLevelEnd = silenceLevel + ((maxLevelEnd - silenceLevel) * (mixLevel / 100));
            let mixPointLevelMaxTime = silenceLevel + ((maxLevelMaxTime - silenceLevel) * (mixLevel / 100));
            let resultMixPoint = { "level": resultCutOut.level, "time": resultCutOut.time };
            let resultMixPointMaxTime = { "level": resultCutOut.level, "time": resultCutOut.time };
            let resultMixPointMaxTimeFound = false;

            for (let i = lastIdx; i >= 0; i--) {
                if (linesArray[i].pts <= resultCutOut.time && linesArray[i].level > mixPointLevelEnd) {
                    resultMixPoint = { "level": linesArray[i].level, "time": linesArray[i].pts };
                    break;
                }
                if (linesArray[i].pts <= resultCutOut.time && linesArray[i].level > mixPointLevelMaxTime && !resultMixPointMaxTimeFound) {
                    resultMixPointMaxTime = { "level": linesArray[i].level, "time": linesArray[i].pts };
                    resultMixPointMaxTimeFound = true;
                }
            }
            if (resultCutOut.time - resultMixPoint.time >= mixPointEndMaxTime) resultMixPoint = resultMixPointMaxTime;
            if (resultMixPoint.time > resultCutOut.time) resultMixPoint = { "level": resultCutOut.level, "time": resultCutOut.time };

            // Silence Detect
            let silenceCount = 0;
            let isSilence = false;
            let startTime = -1;
            let iSilence = 0;
            for (let i = 0; i < linesArray.length; i++) {
                if (iSilence > iCutIn && iSilence < iCutOut) {
                    if (linesArray[i].level <= silenceLevel) {
                        if (!isSilence) { startTime = linesArray[i].pts; isSilence = true; }
                    } else {
                        if (isSilence) { if ((linesArray[i].pts - startTime) >= 3000) silenceCount++; isSilence = false; }
                    }
                }
                iSilence++;
            }

            try { fs.unlinkSync(tempTxtPath); } catch (e) {}

            return {
                status: true,
                filename: filename,
                processed_at: new Date().toISOString(),
                // --- METADATA SECTION ADDED ---
                metadata: songTags,
                // ------------------------------
                markers: {
                    cut_in: resultCutIn.time,
                    cut_out: resultCutOut.time,
                    mix_point_begin: resultMixPointBegin.time,
                    mix_point_end: resultMixPoint.time,
                    duration: audioLength
                },
                details: {
                    max_level: maxLevel,
                    detected_silence_events: silenceCount,
                }
            };

        } else {
            return { status: false, message: "FFmpeg output file not found." };
        }
    } catch (e) {
        return { status: false, message: e.message };
    }
}