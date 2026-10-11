// The live view, drawn by the security worker on the page's canvas (transferred to the worker
// with transferControlToOffscreen): the newest frame, letterboxed on black. Person boxes are
// drawn by the page in the DOM, never into the video.

import { letterbox } from '../geometry.js';

export class LiveCanvas {
  constructor() {
    /** @type {any} OffscreenCanvas */
    this.canvas = null;
    /** @type {any} CanvasRenderingContext2D */
    this.ctx = null;
    this.cssWidth = 0;
    this.cssHeight = 0;
    this.dpr = 1;
    this.drawn = 0;
  }

  /** @param {any} canvas OffscreenCanvas */
  attach(canvas) {
    this.canvas = canvas;
    this.ctx = canvas?.getContext?.('2d', { alpha: false, desynchronized: true }) || null;
    this._size();
  }

  /** @param {number} width CSS px @param {number} height @param {number} dpr */
  resize(width, height, dpr) {
    this.cssWidth = Math.max(0, Math.round(width));
    this.cssHeight = Math.max(0, Math.round(height));
    this.dpr = Math.min(3, Math.max(0.5, Number(dpr) || 1));
    this._size();
  }

  _size() {
    if (!this.canvas || !this.cssWidth || !this.cssHeight) return;
    const w = Math.max(1, Math.round(this.cssWidth * this.dpr));
    const h = Math.max(1, Math.round(this.cssHeight * this.dpr));
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  /** @param {{ image: any, width: number, height: number }|null} frame */
  draw(frame) {
    const g = this.ctx;
    if (!g || !this.canvas) return false;
    const W = this.canvas.width;
    const H = this.canvas.height;
    g.fillStyle = '#000';
    g.fillRect(0, 0, W, H);
    if (!frame || !frame.image) return false;
    const r = letterbox(frame.width, frame.height, W, H);
    g.imageSmoothingQuality = 'medium';
    g.drawImage(frame.image, r.x, r.y, r.width, r.height);
    this.drawn++;
    return true;
  }

  clear() {
    this.draw(null);
  }
}
