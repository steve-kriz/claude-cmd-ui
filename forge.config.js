module.exports = {
  packagerConfig: {
    asar: true,
    name: 'Claude CMD UI'
  },
  rebuildConfig: {},
  plugins: [
    { name: '@electron-forge/plugin-auto-unpack-natives', config: {} }
  ]
};
