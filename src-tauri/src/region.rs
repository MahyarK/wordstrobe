//! The pure parts of the region overlay (`overlay.rs`): geometry and pixel layout. Compiled on every
//! OS so the tests also run on macOS, where the overlay itself is not used (it keeps `screencapture -i`).

use serde::Deserialize;

/// A monitor in physical px of the virtual desktop: x, y, width, height.
pub type Px = (i32, i32, u32, u32);

/// What the overlay page reports after a drag: a rectangle in CSS px relative to its viewport, plus
/// the viewport's size. The page shows its frozen image stretched over the whole viewport, so
/// `image px = css px × image size / viewport size`, whatever the scale factor, zoom or rounding.
#[derive(Deserialize, Clone, Copy, Debug, PartialEq)]
pub struct Selection {
    pub monitor: usize,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub vw: f64,
    pub vh: f64,
}

/// The selection in pixels of its monitor's frozen image: x, y, width, height, clamped to the image.
/// `None` when it is not a usable rectangle or has nothing left after clamping.
pub fn crop_rect(sel: &Selection, image: (u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let Selection { x, y, w, h, vw, vh, .. } = *sel;
    if ![x, y, w, h, vw, vh].iter().all(|v| v.is_finite()) || vw <= 0.0 || vh <= 0.0 || w <= 0.0 || h <= 0.0 {
        return None;
    }
    let (sx, sy) = (f64::from(image.0) / vw, f64::from(image.1) / vh);
    // Both edges are rounded, not the size: neighbouring selections then never gain or lose a pixel.
    let edge = |v: f64, scale: f64, max: u32| (v * scale).round().clamp(0.0, f64::from(max)) as u32;
    let (x0, x1) = (edge(x, sx, image.0), edge(x + w, sx, image.0));
    let (y0, y1) = (edge(y, sy, image.1), edge(y + h, sy, image.1));
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1 - x0, y1 - y0))
}

/// The monitor under `point` (physical px; a seam belongs to the monitor on its right or below), or
/// the nearest one when the point is outside all of them.
pub fn monitor_at(point: (f64, f64), monitors: &[Px]) -> usize {
    let (px, py) = point;
    let span = |start: i32, len: u32| f64::from(start)..f64::from(start) + f64::from(len);
    let contains = |&(x, y, w, h): &Px| span(x, w).contains(&px) && span(y, h).contains(&py);
    // Distance from `p` to a span: 0 when inside.
    let gap = |start: i32, len: u32, p: f64| {
        let s = span(start, len);
        (s.start - p).max(p - s.end).max(0.0)
    };
    let distance = |&(x, y, w, h): &Px| gap(x, w, px).hypot(gap(y, h, py));
    monitors.iter().position(contains).unwrap_or_else(|| {
        let by_distance = |a: &(usize, &Px), b: &(usize, &Px)| distance(a.1).total_cmp(&distance(b.1));
        monitors.iter().enumerate().min_by(by_distance).map_or(0, |(i, _)| i)
    })
}

/// A monitor origin coordinate in physical px. xcap reports Windows coordinates in physical px but
/// divides X11 ones by `Xft.dpi / 96` (while still capturing real pixels), so those are scaled back.
pub fn physical_origin(reported: i32, xcap_scale: f32, divided: bool) -> i32 {
    if divided {
        (f64::from(reported) * f64::from(xcap_scale)).round() as i32
    } else {
        reported
    }
}

const BMP_HEADER: usize = 54;

/// Turns RGBA pixels into a complete BMP file (top-down, 32 bit, opaque) in place. BMP is what the
/// overlay page is served: browsers decode it almost for free, while a PNG of a 4K screen costs
/// ~50 ms to encode and ~50 ms to decode (measured, PLAN §11 M6). It also is the frame store, since
/// it keeps every original pixel.
pub fn rgba_to_bmp(width: u32, height: u32, mut rgba: Vec<u8>) -> Vec<u8> {
    for pixel in rgba.as_chunks_mut::<4>().0 {
        pixel.swap(0, 2); // RGBA -> BGRA
        pixel[3] = 255; // some capture APIs leave alpha at 0
    }
    let size = (BMP_HEADER + rgba.len()) as u32;
    let mut header = Vec::with_capacity(BMP_HEADER);
    header.extend_from_slice(b"BM");
    header.extend_from_slice(&size.to_le_bytes());
    header.extend_from_slice(&[0; 4]); // reserved
    header.extend_from_slice(&(BMP_HEADER as u32).to_le_bytes()); // pixel data offset
    header.extend_from_slice(&40u32.to_le_bytes()); // BITMAPINFOHEADER
    header.extend_from_slice(&(width as i32).to_le_bytes());
    header.extend_from_slice(&(-(height as i32)).to_le_bytes()); // negative = top-down
    header.extend_from_slice(&1u16.to_le_bytes()); // planes
    header.extend_from_slice(&32u16.to_le_bytes()); // bits per pixel
    header.extend_from_slice(&[0; 24]); // BI_RGB, size, resolution, palette
    rgba.splice(0..0, header);
    rgba
}

/// The `rect` (see `crop_rect`) of a BMP made by `rgba_to_bmp` as packed RGB, top-down.
pub fn crop_bmp(bmp: &[u8], width: u32, rect: (u32, u32, u32, u32)) -> Vec<u8> {
    let (x, y, w, h) = rect;
    let row = |r: u32| BMP_HEADER + ((y + r) as usize * width as usize + x as usize) * 4;
    (0..h)
        .flat_map(|r| bmp[row(r)..row(r) + w as usize * 4].as_chunks::<4>().0)
        .flat_map(|bgra| [bgra[2], bgra[1], bgra[0]])
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sel(x: f64, y: f64, w: f64, h: f64, vw: f64, vh: f64) -> Selection {
        Selection { monitor: 0, x, y, w, h, vw, vh }
    }

    #[test]
    fn one_to_one_selection_is_taken_as_is() {
        let s = sel(10.0, 20.0, 300.0, 100.0, 1920.0, 1080.0);
        assert_eq!(crop_rect(&s, (1920, 1080)), Some((10, 20, 300, 100)));
    }

    #[test]
    fn selection_is_scaled_by_image_size_over_viewport() {
        // A 2560x1440 monitor at 150 %: the viewport is 1706.67 x 960 CSS px.
        let s = sel(100.0, 50.0, 400.0, 200.0, 2560.0 / 1.5, 1440.0 / 1.5);
        assert_eq!(crop_rect(&s, (2560, 1440)), Some((150, 75, 600, 300)));
        // Retina: 2x.
        let s = sel(5.0, 5.0, 10.5, 10.0, 1800.0, 1169.0);
        assert_eq!(crop_rect(&s, (3600, 2338)), Some((10, 10, 21, 20)));
    }

    #[test]
    fn selection_is_clamped_to_the_image() {
        let s = sel(-30.0, 1000.0, 130.0, 500.0, 1920.0, 1080.0);
        assert_eq!(crop_rect(&s, (1920, 1080)), Some((0, 1000, 100, 80)));
        let s = sel(1900.0, -50.0, 100.0, 80.0, 1920.0, 1080.0);
        assert_eq!(crop_rect(&s, (1920, 1080)), Some((1900, 0, 20, 30)));
    }

    #[test]
    fn unusable_selections_are_rejected() {
        let image = (1920, 1080);
        assert_eq!(crop_rect(&sel(0.0, 0.0, 0.0, 10.0, 1920.0, 1080.0), image), None);
        assert_eq!(crop_rect(&sel(0.0, 0.0, -5.0, 10.0, 1920.0, 1080.0), image), None);
        assert_eq!(crop_rect(&sel(f64::NAN, 0.0, 5.0, 10.0, 1920.0, 1080.0), image), None);
        assert_eq!(crop_rect(&sel(0.0, 0.0, 5.0, 10.0, 0.0, 1080.0), image), None);
        assert_eq!(crop_rect(&sel(2000.0, 0.0, 50.0, 10.0, 1920.0, 1080.0), image), None); // fully outside
        assert_eq!(crop_rect(&sel(0.0, 0.0, 0.2, 10.0, 1920.0, 1080.0), image), None); // under half a pixel
    }

    const MONITORS: [Px; 3] = [(0, 0, 1920, 1080), (1920, 0, 2560, 1440), (-1280, 200, 1280, 1024)];

    #[test]
    fn monitor_under_the_cursor() {
        assert_eq!(monitor_at((10.0, 10.0), &MONITORS), 0);
        assert_eq!(monitor_at((3000.5, 700.0), &MONITORS), 1);
        assert_eq!(monitor_at((-1.0, 300.0), &MONITORS), 2);
    }

    #[test]
    fn seams_belong_to_the_monitor_on_the_right_or_below() {
        assert_eq!(monitor_at((1919.5, 10.0), &MONITORS), 0);
        assert_eq!(monitor_at((1920.0, 10.0), &MONITORS), 1);
    }

    #[test]
    fn cursor_outside_every_monitor_picks_the_nearest() {
        assert_eq!(monitor_at((1000.0, 1500.0), &MONITORS), 0); // below the first
        assert_eq!(monitor_at((-2000.0, 100.0), &MONITORS), 2);
        assert_eq!(monitor_at((9999.0, 0.0), &MONITORS), 1);
        assert_eq!(monitor_at((5.0, 5.0), &[]), 0);
    }

    #[test]
    fn origins_are_scaled_back_only_where_xcap_divided_them() {
        assert_eq!(physical_origin(1920, 1.5, false), 1920);
        assert_eq!(physical_origin(1280, 1.5, true), 1920); // 1920 / 1.5 = 1280
        assert_eq!(physical_origin(853, 1.5, true), 1280); // 1280 / 1.5 truncated to 853
        assert_eq!(physical_origin(-1280, 1.0, true), -1280);
    }

    #[test]
    fn bmp_is_a_top_down_32_bit_file_with_opaque_bgra_pixels() {
        let rgba = vec![
            1, 2, 3, 0, /**/ 4, 5, 6, 7, //
            8, 9, 10, 11, /**/ 12, 13, 14, 15,
        ];
        let bmp = rgba_to_bmp(2, 2, rgba);
        assert_eq!(&bmp[..2], b"BM");
        assert_eq!(u32::from_le_bytes(bmp[2..6].try_into().unwrap()) as usize, bmp.len());
        assert_eq!(u32::from_le_bytes(bmp[10..14].try_into().unwrap()), 54);
        assert_eq!(i32::from_le_bytes(bmp[18..22].try_into().unwrap()), 2);
        assert_eq!(i32::from_le_bytes(bmp[22..26].try_into().unwrap()), -2);
        assert_eq!(u16::from_le_bytes(bmp[28..30].try_into().unwrap()), 32);
        assert_eq!(&bmp[30..34], &[0; 4]); // BI_RGB
        assert_eq!(&bmp[54..58], &[3, 2, 1, 255]);
        assert_eq!(bmp.len(), 54 + 16);
    }

    #[test]
    fn crop_returns_the_original_pixels_as_rgb() {
        // 3x3 image, pixel (x, y) = [x, y, 9, 255]
        let rgba = (0..3u8).flat_map(|y| (0..3u8).flat_map(move |x| [x, y, 9, 255])).collect();
        let bmp = rgba_to_bmp(3, 3, rgba);
        assert_eq!(crop_bmp(&bmp, 3, (1, 1, 2, 2)), [1, 1, 9, 2, 1, 9, 1, 2, 9, 2, 2, 9]);
        assert_eq!(crop_bmp(&bmp, 3, (0, 0, 3, 3)).len(), 27);
        assert_eq!(crop_bmp(&bmp, 3, (2, 2, 1, 1)), [2, 2, 9]);
    }
}
