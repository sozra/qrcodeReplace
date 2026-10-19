/* Local worker: no image or decoded contents leave the browser. */
"use strict";
importScripts("vendor/jsQR.js", "qr-detection.js");

self.onmessage = async (event) => {
  const { id, pixels, maxDetections } = event.data;
  try {
    const results = await self.QRDetection.scanPixels(pixels, { maxDetections });
    self.postMessage({ id, results });
  } catch (error) {
    self.postMessage({ id, error: error.message || "二维码识别失败" });
  }
};
