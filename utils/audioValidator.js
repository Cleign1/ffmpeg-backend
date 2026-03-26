import ffmpeg from 'fluent-ffmpeg';
import path from 'path';
import fs from 'fs';

/**
 * Validates audio file integrity using ffprobe
 * @param {string} filePath - Absolute path to the audio file
 * @returns {Promise<Object>} - Health check result with status and metadata
 */
export async function validateAudioFile(filePath) {
    return new Promise((resolve) => {
        // Check if file exists
        if (!fs.existsSync(filePath)) {
            return resolve({
                isHealthy: false,
                error: 'File not found',
                errorCode: 'FILE_NOT_FOUND'
            });
        }

        // Check file size
        const stats = fs.statSync(filePath);
        if (stats.size === 0) {
            return resolve({
                isHealthy: false,
                error: 'File is empty',
                errorCode: 'EMPTY_FILE',
                metadata: { size: 0 }
            });
        }

        // Use ffprobe to validate and extract metadata
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                return resolve({
                    isHealthy: false,
                    error: err.message || 'Failed to read audio metadata',
                    errorCode: 'INVALID_AUDIO',
                    metadata: { size: stats.size }
                });
            }

            // Check for valid audio streams
            const audioStreams = metadata.streams.filter(s => s.codec_type === 'audio');
            if (audioStreams.length === 0) {
                return resolve({
                    isHealthy: false,
                    error: 'No audio stream found',
                    errorCode: 'NO_AUDIO_STREAM',
                    metadata: { size: stats.size }
                });
            }

            const audioStream = audioStreams[0];
            const duration = metadata.format.duration;

            // Check for valid duration
            if (!duration || duration <= 0 || isNaN(duration)) {
                return resolve({
                    isHealthy: false,
                    error: 'Invalid or missing duration',
                    errorCode: 'INVALID_DURATION',
                    metadata: {
                        size: stats.size,
                        format: metadata.format.format_name
                    }
                });
            }

            // Check for codec issues
            if (!audioStream.codec_name) {
                return resolve({
                    isHealthy: false,
                    error: 'Audio codec not recognized',
                    errorCode: 'INVALID_CODEC',
                    metadata: {
                        size: stats.size,
                        duration,
                        format: metadata.format.format_name
                    }
                });
            }

            // File appears healthy
            resolve({
                isHealthy: true,
                metadata: {
                    filename: path.basename(filePath),
                    size: stats.size,
                    duration: parseFloat(duration.toFixed(2)),
                    format: metadata.format.format_name,
                    formatLong: metadata.format.format_long_name,
                    codec: audioStream.codec_name,
                    codecLong: audioStream.codec_long_name,
                    bitrate: metadata.format.bit_rate ? parseInt(metadata.format.bit_rate) : null,
                    sampleRate: audioStream.sample_rate ? parseInt(audioStream.sample_rate) : null,
                    channels: audioStream.channels || null,
                    tags: metadata.format.tags || {}
                }
            });
        });
    });
}

/**
 * Quick validation check (lighter version)
 * @param {string} filePath - Absolute path to the audio file
 * @returns {Promise<boolean>} - True if file is healthy
 */
export async function quickValidate(filePath) {
    const result = await validateAudioFile(filePath);
    return result.isHealthy;
}
