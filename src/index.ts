import Alpine from 'alpinejs';
import ImageCompare from './lib/image-compare-viewer.min';
import WebSR from '@websr/websr';
import type { WorkerRequestMessage, WorkerResponseMessage } from './types/worker-messages';

import 'bootstrap';
import 'bootstrap/dist/css/bootstrap.min.css';
import "./index.css";
import "./lib/image-compare-viewer.min.css";

const MAX_FILE_BLOB_SIZE=1900*1024*1024; //Just under 2GB, max ArrayBufferSize

// Web Worker for video processing
const worker = new Worker(new URL('./worker.ts', import.meta.url));

// Canvas and video elements
let upscaled_canvas: HTMLCanvasElement;
let original_canvas: HTMLCanvasElement;
let video: HTMLVideoElement;

// Network selection
type NetworkSize = 'small' | 'medium' | 'large';
type ContentType = 'rl' | 'an' | '3d';

let size: NetworkSize = 'medium';
let content: ContentType = 'rl';

// Video data
let download_name: string;
let inputFileHandle: FileSystemFileHandle;
let inputFileHandles: FileSystemFileHandle[] = [];
let gpu: any;
let websr: WebSR;
let canvasesTransferred = false;
let imageCompareMounted = false;
let currentProcessResolve: ((data: Blob | null) => void) | null = null;
let currentProcessReject: ((message: string) => void) | null = null;

// AI model weights for different network sizes and content types
type WeightsMap = {
    [K in NetworkSize]: {
        [C in ContentType]: any;
    };
};

const weights: WeightsMap = {
    'large': {
        'rl': require('./weights/cnn-2x-l-rl.json'),
        'an': require('./weights/cnn-2x-l-an.json'),
        '3d': require('./weights/cnn-2x-l-3d.json'),
    },
    'medium': {
        'rl': require('./weights/cnn-2x-m-rl.json'),
        'an': require('./weights/cnn-2x-m-an.json'),
        '3d': require('./weights/cnn-2x-m-3d.json'),
    },
    'small': {
        'rl': require('./weights/cnn-2x-s-rl.json'),
        'an': require('./weights/cnn-2x-s-an.json'),
        '3d': require('./weights/cnn-2x-s-3d.json'),
    }
};

// Network name mapping
const networks: Record<NetworkSize, { name: string }> = {
    'small': {
        name: "anime4k/cnn-2x-s",
    },
    'medium': {
        name: "anime4k/cnn-2x-m",
    },
    'large': {
        name: "anime4k/cnn-2x-l",
    }
};

// Declare global window functions for Alpine to call and File System Access API
declare global {
    interface Window {
        chooseFile: (e?: Event) => Promise<void>;
        initRecording: () => Promise<void>;
        fullScreenPreview: (e?: Event) => Promise<void>;
        switchNetworkSize: (el: HTMLInputElement) => Promise<void>;
        switchNetworkStyle: (el: HTMLInputElement) => Promise<void>;
        showSaveFilePicker: (options?: any) => Promise<FileSystemFileHandle>;
        showOpenFilePicker: (options?: any) => Promise<FileSystemFileHandle[]>;
        showDirectoryPicker?: (options?: any) => Promise<FileSystemDirectoryHandle>;
        togglePause: () => void;
    }
}

document.addEventListener("DOMContentLoaded", index);

//===================  Initial Load ===========================

/**
 * Main initialization function called on page load
 */
async function index(): Promise<void> {
    Alpine.store('state', 'init');

    Alpine.start();
    document.body.style.display = "block";

    upscaled_canvas = document.getElementById("upscaled") as HTMLCanvasElement;
    original_canvas = document.getElementById('original') as HTMLCanvasElement;

    if (!("VideoEncoder" in window)) return showUnsupported("WebCodecs");

    if (!window.showSaveFilePicker) return showUnsupported("File Write System API");

    worker.postMessage({ cmd: 'isSupported' } satisfies WorkerRequestMessage);

    window.chooseFile = chooseFile;
}

/**
 * Show unsupported browser feature message
 */
function showUnsupported(text: string): void {
    Alpine.store('component', text);
    Alpine.store('state', 'unsupported');
}

/**
 * Prompt user to choose a video file using File System Access API
 */
async function chooseFile(e?: Event): Promise<void> {
    try {
        const fileHandles = await window.showOpenFilePicker({
            types: [{
                description: 'Video Files',
                accept: { 'video/mp4': ['.mp4'] }
            }],
            multiple: true
        });

        inputFileHandles = fileHandles;
        Alpine.store('batch_total', fileHandles.length);
        Alpine.store('batch_completed', 0);
        Alpine.store('batch_results', []);

        await loadVideo(fileHandles[0]);
    } catch (e) {
        // User cancelled file picker
        console.log('File selection cancelled');
    }
}

//===================  Preview ===========================

/**
 * Load video file from FileSystemFileHandle
 */
async function loadVideo(fileHandle: FileSystemFileHandle, stateAfterPreview: string = 'preview'): Promise<void> {
    Alpine.store('state', 'loading');

    // Store the file handle for later processing
    inputFileHandle = fileHandle;

    // Get the file to create a preview
    const file = await fileHandle.getFile();

    // Set up download name
    download_name = getOutputName(file.name);
    Alpine.store('download_name', download_name);
    Alpine.store('filename', file.name);

    // Read file for preview setup
    const arrayBuffer = await file.arrayBuffer();
    await setupPreview(arrayBuffer, stateAfterPreview);
}

/**
 * Set up the preview UI with before/after comparison
 */
async function setupPreview(data: ArrayBuffer, stateAfterPreview: string = 'preview'): Promise<void> {
    video = document.createElement('video');

    const fileBlob = new Blob([data], { type: "video/mp4" });

    video.src = URL.createObjectURL(fileBlob);

    const imageCompare = document.getElementById('image-compare-outer') as HTMLElement;

    return new Promise((resolve, reject) => {

    video.onerror = function () {
        reject(new Error('The selected video could not be loaded'));
    };

    video.onloadeddata = async function (){



        Alpine.store('width', video.videoWidth);
        Alpine.store('height', video.videoHeight);
        if (!canvasesTransferred) {
            upscaled_canvas.width = video.videoWidth*2;
            upscaled_canvas.height = video.videoHeight*2;
            original_canvas.width = video.videoWidth*2;
            original_canvas.height = video.videoHeight*2;
        }


        imageCompare.style.height = '318px';
        imageCompare.style.width =  `${Math.round(video.videoWidth/video.videoHeight*318)}px`
        imageCompare.style.margin = 'auto';
        imageCompare.style.position = 'relative';


        if (!imageCompareMounted) {
            new ImageCompare(document.getElementById('image-compare')).mount();
            imageCompareMounted = true;
        }
        const showPreviewAndHandleErrors = async function () {
            try {
                await showPreview();
            } catch (e) {
                reject(e);
            }
        };

        video.currentTime = video.duration * 0.2 || 0;
        if(video.requestVideoFrameCallback)  video.requestVideoFrameCallback(showPreviewAndHandleErrors);
        else requestAnimationFrame(showPreviewAndHandleErrors);

        window.togglePause = function () {
            const currentState = Alpine.store('state');
            if (currentState === 'processing') {
                worker.postMessage({ cmd: 'pause' } satisfies WorkerRequestMessage);
            } else if (currentState === 'paused') {
                worker.postMessage({ cmd: 'resume' } satisfies WorkerRequestMessage);
            }
        };

    }




    async function showPreview(){

        const fullScreenButton = document.getElementById('full-screen');


        window.initRecording = initRecording;
        window.fullScreenPreview = fullScreenPreview;

        const bitmap = await createImageBitmap(video);


        const transferables: Transferable[] = [bitmap];
        const initData: any = {
            bitmap,
            resolution: {
                width: video.videoWidth,
                height: video.videoHeight
            }
        };

        if (!canvasesTransferred) {
            const upscaled = upscaled_canvas.transferControlToOffscreen();
            const original = original_canvas.transferControlToOffscreen();

            initData.upscaled = upscaled;
            initData.original = original;
            transferables.push(upscaled, original);
            canvasesTransferred = true;
        }

        worker.postMessage({cmd: "init", data: initData}, transferables);


        // Default to 'rl' (real life) network
        content = 'rl';
        await updateNetwork();
        Alpine.store('style', 'rl');









        function setFullScreenLocation(){
            const containerWidth = Math.round(video.videoWidth/video.videoHeight*318);
            const containerHeight = 318;
            
            // Position at bottom-right of the preview container (with small padding)
            fullScreenButton.style.left = `${imageCompare.offsetLeft + containerWidth - 20}px`;
            fullScreenButton.style.top = `${imageCompare.offsetTop + containerHeight - 20}px`;
        }

        setTimeout(setFullScreenLocation, 20);
        setTimeout(setFullScreenLocation, 60);
        setTimeout(setFullScreenLocation, 200);





        imageCompare.addEventListener('fullscreenchange', function () {
            if(!document.fullscreenElement){
                // Reset canvas styles
                upscaled_canvas.style.width = ``;
                upscaled_canvas.style.height = ``;
                original_canvas.style.width = ``;
                original_canvas.style.height = ``;
                
                // Reset container styles to original preview dimensions
                const imageCompareOuter = document.getElementById('image-compare-outer');
                const imageCompareInner = document.getElementById('image-compare');
                
                // Reset outer container
                imageCompareOuter.style.width = ``;
                imageCompareOuter.style.height = ``;
                imageCompareOuter.style.backgroundColor = ``;
                imageCompareOuter.style.display = ``;
                imageCompareOuter.style.justifyContent = ``;
                imageCompareOuter.style.alignItems = ``;
                
                // Reset inner container to original preview size
                imageCompareInner.style.height = '318px';
                imageCompareInner.style.width = `${Math.round(video.videoWidth/video.videoHeight*318)}px`;
                imageCompareInner.style.margin = 'auto';
                imageCompareInner.style.position = 'relative';
            }
        });

        let bitrate = getBitrate();

        const estimated_size = (bitrate/8)*video.duration + (128/8)*video.duration; // Assume 128 kbps audio

        if(estimated_size > MAX_FILE_BLOB_SIZE){
            Alpine.store('target', 'writer');
        } else {
            Alpine.store('target', 'blob');
        }

        const quota = (await navigator.storage.estimate()).quota;

        if(estimated_size > quota){
            return showError(`The video is too big. It would output a file of ${humanFileSize(estimated_size)} but the browser can only write files up to ${humanFileSize(quota)}`);
        }


        Alpine.store('size', humanFileSize(estimated_size))


        function canvasFullScreen(){
            // Calculate aspect ratios
            const videoAspectRatio = video.videoWidth / video.videoHeight;
            const screenAspectRatio = window.innerWidth / window.innerHeight;
            
            let displayWidth, displayHeight;

            const imageCompareOuter = document.getElementById('image-compare-outer');
            const imageCompareInner = document.getElementById('image-compare');
            
            // If video is wider than screen, fit to width (letterbox on top/bottom)
            if (videoAspectRatio > screenAspectRatio) {
                displayWidth = window.innerWidth;
                displayHeight = window.innerWidth / videoAspectRatio;
            } 
            // If video is taller than screen, fit to height (pillarbox on sides)
            else {
                displayWidth = window.innerHeight * videoAspectRatio;
                displayHeight = window.innerHeight;
            }
            
            // Style the outer container to fill screen with black background and center content
            imageCompareOuter.style.width = `${window.innerWidth}px`;
            imageCompareOuter.style.height = `${window.innerHeight}px`;
            imageCompareOuter.style.backgroundColor = 'black';
            imageCompareOuter.style.display = 'flex';
            imageCompareOuter.style.justifyContent = 'center';
            imageCompareOuter.style.alignItems = 'center';
            

            console.log("Image Compare Outer", imageCompareOuter);
            console.log("Image Compare Inner", imageCompareInner);
            // Size the inner container to maintain aspect ratio
            imageCompareInner.style.width = `${displayWidth}px`;
            imageCompareInner.style.height = `${displayHeight}px`;
            
            // Let the canvases fill their parent container
            upscaled_canvas.style.width = `${displayWidth}px`;
            upscaled_canvas.style.height = `${displayHeight}px`;
            original_canvas.style.width = `${displayWidth}px`;
            original_canvas.style.height = `${displayHeight}px`;
        }

        async function fullScreenPreview(e) {
            imageCompare.requestFullscreen();
            setTimeout(canvasFullScreen, 20);
            setTimeout(canvasFullScreen, 60);
            setTimeout(canvasFullScreen, 200);

        }


        Alpine.store('state', stateAfterPreview);




        window.switchNetworkSize = async function(el: HTMLInputElement){
            if(el.value !== size){
                size = el.value as NetworkSize;

                await updateNetwork();
            }
        }

        window.switchNetworkStyle = async function(el: HTMLInputElement){
            if(el.value !== content){
                content = el.value as ContentType;

                await updateNetwork();
            }
        }

        resolve();
    }

    });
}


/**
 * Handle messages from the video processing worker
 */
worker.onmessage = function (event: MessageEvent<WorkerResponseMessage>) {
    if (event.data.cmd === 'isSupported') {
        const supported = event.data.data;

        if (!supported) return showUnsupported("WebGPU");

    } else if (event.data.cmd === 'progress') {
        Alpine.store('progress', event.data.data);
        if (Alpine.store('state') !== 'paused') {
            Alpine.store('state', 'processing');
        }

    } else if (event.data.cmd === 'process') {
        // Processing started

    } else if (event.data.cmd === 'error') {
        if (currentProcessReject) {
            const reject = currentProcessReject;
            currentProcessResolve = null;
            currentProcessReject = null;
            reject(event.data.data);
            return;
        }

        showError(event.data.data);

    } else if (event.data.cmd === 'eta') {
        Alpine.store('eta', event.data.data);

    } else if (event.data.cmd === 'finished') {
        if (currentProcessResolve) {
            const resolve = currentProcessResolve;
            currentProcessResolve = null;
            currentProcessReject = null;
            resolve(event.data.data);
            return;
        }

        Alpine.store('state', 'complete');
        Alpine.store('download_url', event.data.data ? window.URL.createObjectURL(event.data.data) : null);
    }
    else if (event.data.cmd === 'paused') {
        Alpine.store('state', 'paused');
    } else if (event.data.cmd === 'resumed') {
        Alpine.store('state', 'processing');
    }
};



/**
 * Switch to a different upscaling network
 */
async function updateNetwork(): Promise<void> {
    const bitmap = await createImageBitmap(video);

    worker.postMessage({
        cmd: 'network',
        data: {
            name: networks[size].name,
            bitmap,
            weights: weights[size][content]
        }
    } satisfies WorkerRequestMessage);
}

//===================  Process ===========================

/**
 * Start the video upscaling process
 */
async function initRecording(): Promise<void> {
    if (inputFileHandles.length > 1) {
        await initBatchRecording();
        return;
    }

    Alpine.store('state', 'loading');

    let bitrate = getBitrate();
    const estimated_size = (bitrate / 8) * video.duration + (128 / 8) * video.duration; // Assume 128 kbps audio

    let outputHandle: FileSystemFileHandle | undefined;

    // Max Blob size - 10 MB (for testing, should be much higher in production)
    if (estimated_size > MAX_FILE_BLOB_SIZE) {
        try {
            outputHandle = await showFilePicker();
        } catch (e) {
            console.warn("User aborted request");
            return Alpine.store('state', 'preview');
        }
    }

    worker.postMessage({
        cmd: "process",
        inputHandle: inputFileHandle,
        outputHandle
    } satisfies WorkerRequestMessage);
}

/**
 * Process all selected videos one after another and save them into a folder.
 */
async function initBatchRecording(): Promise<void> {
    if (!window.showDirectoryPicker) {
        return showUnsupported("Directory Picker API");
    }

    let outputDirectory: FileSystemDirectoryHandle;

    try {
        outputDirectory = await window.showDirectoryPicker({
            mode: 'readwrite',
            startIn: 'downloads'
        });
    } catch (e) {
        console.warn("User aborted output folder request");
        return Alpine.store('state', 'preview');
    }

    Alpine.store('batch_total', inputFileHandles.length);
    Alpine.store('batch_completed', 0);
    Alpine.store('batch_results', []);
    Alpine.store('target', 'writer');
    Alpine.store('state', 'loading');

    try {
        const usedOutputNames = new Set<string>();

        for (let i = 0; i < inputFileHandles.length; i++) {
            const handle = inputFileHandles[i];
            const file = await handle.getFile();
            const outputName = getUniqueOutputName(file.name, usedOutputNames);
            const outputHandle = await outputDirectory.getFileHandle(outputName, { create: true });

            Alpine.store('batch_current', i + 1);
            Alpine.store('batch_completed', i);
            Alpine.store('progress', 0);
            Alpine.store('eta', 'calculating...');

            await loadVideo(handle, 'processing');
            await runWorkerProcess(handle, outputHandle);

            const results = Alpine.store('batch_results') || [];
            Alpine.store('batch_results', [...results, outputName]);
            Alpine.store('batch_completed', i + 1);
        }

        Alpine.store('download_name', `${inputFileHandles.length} upscaled videos`);
        Alpine.store('state', 'complete');
    } catch (e) {
        showError(e instanceof Error ? e.message : String(e));
    } finally {
        currentProcessResolve = null;
        currentProcessReject = null;
    }
}

/**
 * Run one worker process and resolve when the worker reports completion.
 */
function runWorkerProcess(inputHandle: FileSystemFileHandle, outputHandle?: FileSystemFileHandle): Promise<Blob | null> {
    return new Promise((resolve, reject) => {
        currentProcessResolve = resolve;
        currentProcessReject = reject;

        worker.postMessage({
            cmd: "process",
            inputHandle,
            outputHandle
        } satisfies WorkerRequestMessage);
    });
}

/**
 * Build the default output filename for a source file.
 */
function getOutputName(filename: string): string {
    const dotIndex = filename.lastIndexOf(".");

    if (dotIndex === -1) {
        return `${filename}-upscaled.mp4`;
    }

    return `${filename.slice(0, dotIndex)}-upscaled.mp4`;
}

/**
 * Build a unique output filename within one batch.
 */
function getUniqueOutputName(filename: string, usedOutputNames: Set<string>): string {
    const outputName = getOutputName(filename);

    if (!usedOutputNames.has(outputName)) {
        usedOutputNames.add(outputName);
        return outputName;
    }

    const dotIndex = outputName.lastIndexOf(".");
    const name = dotIndex === -1 ? outputName : outputName.slice(0, dotIndex);
    const extension = dotIndex === -1 ? "" : outputName.slice(dotIndex);
    let counter = 2;
    let uniqueName = `${name}-${counter}${extension}`;

    while (usedOutputNames.has(uniqueName)) {
        counter++;
        uniqueName = `${name}-${counter}${extension}`;
    }

    usedOutputNames.add(uniqueName);
    return uniqueName;
}

/**
 * Display error message to user
 */
function showError(message: string): void {
    Alpine.store('state', 'error');
    Alpine.store('error', message);
}

/**
 * Calculate target bitrate based on video resolution
 */
function getBitrate(): number {
    return 5e6 * Math.sqrt((video.videoWidth * video.videoHeight * 4) / (1280 * 720));
}

/**
 * Format bytes into human-readable file size
 */
function humanFileSize(bytes: number, si: boolean = false, dp: number = 1): string {
    const thresh = si ? 1000 : 1024;

    if (Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }

    const units = si
        ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
        : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    let u = -1;
    const r = 10 ** dp;

    do {
        bytes /= thresh;
        ++u;
    } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

    return bytes.toFixed(dp) + ' ' + units[u];
}

/**
 * Show native file picker for saving output video
 */
async function showFilePicker(): Promise<FileSystemFileHandle> {
    const handle = await window.showSaveFilePicker({
        startIn: 'downloads',
        suggestedName: download_name,
        types: [{
            description: 'Video File',
            accept: { 'video/mp4': ['.mp4'] }
        }],
    });

    return handle;
}



