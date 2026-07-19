const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');

module.exports = {
    packagerConfig: {
        asar: {
            // whisperWorker.js must be unpacked: worker_threads cannot load files from inside asar
            unpack: '{**/{onnxruntime-node,onnxruntime-common,@huggingface/transformers,sharp,@img}/**,**/whisperWorker.js}',
        },
        extraResource: ['./src/assets/SystemAudioDump'],
        name: 'Cheating Daddy',
        icon: 'src/assets/logo',
        appBundleId: 'com.cheatingdaddy.app',
        appCategoryType: 'public.app-category.productivity',
        extendInfo: {
            // Required: macOS kills a packaged app that accesses the mic without this
            NSMicrophoneUsageDescription: 'Microphone access is used to transcribe your side of the conversation.',
            NSAudioCaptureUsageDescription: 'System audio is captured to transcribe the conversation.',
        },
        // macOS signing: set APPLE_SIGNING_IDENTITY to enable
        // (find yours with `security find-identity -v -p codesigning`)
        ...(process.env.APPLE_SIGNING_IDENTITY
            ? {
                  osxSign: {
                      identity: process.env.APPLE_SIGNING_IDENTITY,
                      optionsForFile: () => ({ entitlements: 'entitlements.plist' }),
                  },
              }
            : {}),
        // Notarization: set all three env vars to enable
        ...(process.env.APPLE_ID && process.env.APPLE_ID_PASSWORD && process.env.APPLE_TEAM_ID
            ? {
                  osxNotarize: {
                      appleId: process.env.APPLE_ID,
                      appleIdPassword: process.env.APPLE_ID_PASSWORD,
                      teamId: process.env.APPLE_TEAM_ID,
                  },
              }
            : {}),
    },
    rebuildConfig: {},
    makers: [
        {
            name: '@electron-forge/maker-squirrel',
            config: {
                name: 'cheating-daddy',
                productName: 'Cheating Daddy',
                shortcutName: 'Cheating Daddy',
                createDesktopShortcut: true,
                createStartMenuShortcut: true,
            },
        },
        {
            name: '@electron-forge/maker-dmg',
            platforms: ['darwin'],
        },
        {
            name: '@reforged/maker-appimage',
            platforms: ['linux'],
            config: {
                options: {
                    name: 'Cheating Daddy',
                    productName: 'Cheating Daddy',
                    genericName: 'AI Assistant',
                    description: 'AI assistant for interviews and learning',
                    categories: ['Development', 'Education'],
                    icon: 'src/assets/logo.png'
                }
            },
        },
    ],
    plugins: [
        {
            name: '@electron-forge/plugin-auto-unpack-natives',
            config: {},
        },
        // Fuses are used to enable/disable various Electron functionality
        // at package time, before code signing the application
        new FusesPlugin({
            version: FuseVersion.V1,
            [FuseV1Options.RunAsNode]: false,
            [FuseV1Options.EnableCookieEncryption]: true,
            [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
            [FuseV1Options.EnableNodeCliInspectArguments]: false,
            [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
            [FuseV1Options.OnlyLoadAppFromAsar]: true,
        }),
    ],
};
