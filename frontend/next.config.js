const nextConfig = {
  distDir: "build",
  output: "export", // Static export for Electron
  images: {
    unoptimized: true, // Required for static export
  },
  // Note: rewrites don't work with static export
  // API calls will be handled directly in the app
};

module.exports = nextConfig;
