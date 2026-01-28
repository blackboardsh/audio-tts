import pkg from "./package.json";

export default {
    app: {
        name: "Audio TTS",
        identifier: "audio-tts.app",
        version: pkg.version,
    },
    build: {
        views: {
            mainview: {
                entrypoint: "src/mainview/index.ts",
                external: [],
            },
        },
        copy: {
            "src/mainview/index.html": "views/mainview/index.html",
            "src/mainview/index.css": "views/mainview/index.css",
            "python": "python",
        },
        mac: {
            bundleCEF: false,
            codesign: false,
            notarize: false,
        },
        linux: {
            bundleCEF: false,
        },
        win: {
            bundleCEF: false,
        },
    },
    release: {        
        baseUrl: "https://github.com/blackboardsh/audio-tts/releases/latest/download",
    },
};
