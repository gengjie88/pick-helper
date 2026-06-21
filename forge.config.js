module.exports = {
  packagerConfig: {
    name: 'PickHelper',
    executableName: 'PickHelper',
    icon: 'assets/icon.png',
    asar: true,
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['win32'],
      config: {
        name: 'PickHelper',
      },
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
    },
  ],
};
