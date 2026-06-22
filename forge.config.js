module.exports = {
  packagerConfig: {
    name: 'PickHelper',
    executableName: 'PickHelper',
    icon: 'assets/icon',
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
      config: {
        name: 'PickHelper',
        icon: 'assets/icon.png',
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        iconUrl: 'https://raw.githubusercontent.com/your-repo/pick-helper/main/assets/icon.ico',
        setupIcon: 'assets/icon.ico',
      },
    },
  ],
};
