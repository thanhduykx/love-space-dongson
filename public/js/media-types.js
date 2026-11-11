const giaDinhMedia = {
  imageExtensions: /\.(?:jpe?g|jfif|pjpe?g|png|apng|gif|webp|svg|svgz|heic|heif|hif|avif|bmp|dib|tiff?|ico|jxl|dng|raw|cr2|cr3|crw|nef|nrw|arw|srf|sr2|raf|orf|rw2|rwl|pef|srw|x3f|3fr|fff|iiq|mos|mrw|erf|kdc|dcr|dcs|mef|mdc|psd|psb|tga|exr|hdr|dds|jp2|j2k|jpf|jpx|jpm|jxr|wdp|hdp|pbm|pgm|ppm|pnm|pcx|qoi|thm|aae|xmp|srt|vtt)$/i,
  videoExtensions: /\.(?:mp4|m4v|mov|qt|webm|mkv|avi|mpeg|mpg|mpe|m1v|m2v|ts|mts|m2ts|mxf|3gp|3g2|ogv|ogg|wmv|asf|flv|f4v|vob|divx|rm|rmvb|mjpeg|mjpg|lrv|hevc|h264|h265|av1)$/i,
  mediaMime: /^(?:image|video)\/[a-z0-9][a-z0-9.+-]*$/i,
  accepts(name, type) {
    return this.imageExtensions.test(name) || this.videoExtensions.test(name) || this.mediaMime.test(type);
  }
};

if (typeof module !== 'undefined') module.exports = giaDinhMedia;
