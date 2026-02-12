import pkg from "./package.json";

export default {
    app: {
        name: "Audio TTS",
        identifier: "sh.blackboard.audio-tts",
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
            icons: "icon.iconset",
            bundleCEF: false,
            codesign: true,
            notarize: true,
        },
    },
    release: {        
        baseUrl: "https://github.com/blackboardsh/audio-tts/releases/latest/download",
    },
};
