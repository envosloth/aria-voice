//! Ember orb (spec §6.6), ported 1:1 from the Harness Concepts design doc
//! (turn 4 "ember sphere v2"): seeded debris rings at mixed 3D orientations
//! around a white-hot pulsing core, four state palettes/motions.
//!
//! Pure view: caller passes elapsed time + state; nothing here owns a loop.
//! ponytail: egui painter (points/lines/mesh fans) instead of a wgpu shader —
//! ~1k primitives at 60 fps is nothing; move to wgpu only if profiling says so.

use egui::{Color32, Painter, Pos2, Rect, Stroke};

pub const TAU: f32 = std::f32::consts::TAU;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OrbState {
    Idle,     // blue · dim embers, slow swirl
    Thinking, // violet · swirl accelerates
    Speaking, // cyan · core flares to voice
    Tools,    // amber · debris rings spin up
}

struct Mode {
    spd: f32,
    amp: f32,
    flare: f32,
}

/// [ember_rgb, highlight_rgb]
struct Palette {
    e: [f32; 3],
    hh: [f32; 3],
}

fn mode(s: OrbState) -> Mode {
    match s {
        OrbState::Idle => Mode { spd: 0.45, amp: 0.55, flare: 0.55 },
        OrbState::Thinking => Mode { spd: 0.9, amp: 0.7, flare: 0.7 },
        OrbState::Speaking => Mode { spd: 0.85, amp: 0.8, flare: 0.9 },
        OrbState::Tools => Mode { spd: 1.0, amp: 0.7, flare: 0.7 },
    }
}

fn palette(s: OrbState) -> Palette {
    match s {
        OrbState::Idle => Palette { e: [70.0, 120.0, 235.0], hh: [225.0, 240.0, 255.0] },
        OrbState::Thinking => Palette { e: [150.0, 80.0, 255.0], hh: [242.0, 232.0, 255.0] },
        OrbState::Speaking => Palette { e: [0.0, 170.0, 210.0], hh: [220.0, 250.0, 255.0] },
        OrbState::Tools => Palette { e: [255.0, 120.0, 15.0], hh: [255.0, 246.0, 220.0] },
    }
}

/// Continuously-smoothable render parameters: the UI lerps these per frame
/// (state changes glide) and modulates amp/flare with live speech RMS so the
/// orb + debris react only while the agent is actually speaking (spec §6.6).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OrbParams {
    pub spd: f32,
    pub amp: f32,
    pub flare: f32,
    pub e: [f32; 3],
    pub hh: [f32; 3],
}

pub fn params_for(s: OrbState) -> OrbParams {
    let m = mode(s);
    let p = palette(s);
    OrbParams { spd: m.spd, amp: m.amp, flare: m.flare, e: p.e, hh: p.hh }
}

pub fn state_hue_color(s: OrbState) -> Color32 {
    let p = palette(s);
    // mid-ramp accent used for badges/labels
    let w = 0.6f32;
    Color32::from_rgb(
        (p.e[0] + (p.hh[0] - p.e[0]) * w) as u8,
        (p.e[1] + (p.hh[1] - p.e[1]) * w) as u8,
        (p.e[2] + (p.hh[2] - p.e[2]) * w) as u8,
    )
}

struct Dot {
    x: f32,
    y: f32,
    z: f32,
    s: f32,
    h: f32,
    tw: f32,
    w: f32,
}

struct Seg {
    a0: f32,
    len: f32,
    al: f32,
}

struct Deb {
    a: f32,
    rr: f32,
    s: f32,
    h: f32,
    tw: f32,
    w: f32,
}

struct Ring {
    rb: f32,
    u: [f32; 3],
    v: [f32; 3],
    w: f32,
    h: f32,
    lw: f32,
    segs: Vec<Seg>,
    deb: Vec<Deb>,
}

pub struct Orb {
    size: f32,
    dots: Vec<Dot>,
    rings: Vec<Ring>,
}

/// FNV-1a seed + LCG — identical constants to the design doc so the orb is
/// the same orb.
struct Rng(u32);

impl Rng {
    fn from_seed(seed: &str) -> Self {
        let mut s: u32 = 2166136261;
        for b in seed.bytes() {
            s = (s ^ b as u32).wrapping_mul(16777619);
        }
        Rng(s)
    }
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 as f32 / 4294967296.0
    }
}

impl Orb {
    pub fn new(seed: &str, size: f32) -> Self {
        let mut rnd = Rng::from_seed(seed);
        let r_max = size / 2.0;
        let mut dots = Vec::new();
        let n_core = (size * 0.5).round() as usize;
        for _ in 0..n_core {
            let r = r_max * (0.02 + 0.17 * rnd.next().powf(1.5));
            let th = rnd.next() * TAU;
            let ph = (2.0 * rnd.next() - 1.0).acos();
            dots.push(Dot {
                x: r * ph.sin() * th.cos(),
                y: r * ph.cos() * 0.8,
                z: r * ph.sin() * th.sin(),
                s: 0.7 + rnd.next() * 1.7,
                h: 0.72 + rnd.next() * 0.28,
                tw: rnd.next() * TAU,
                w: 0.7 + rnd.next() * 0.8,
            });
        }
        let n_vol = (size * 0.85).round() as usize;
        for _ in 0..n_vol {
            let r = r_max * (0.24 + 0.72 * rnd.next().powf(0.65));
            let th = rnd.next() * TAU;
            let ph = (2.0 * rnd.next() - 1.0).acos();
            dots.push(Dot {
                x: r * ph.sin() * th.cos(),
                y: r * ph.cos() * 0.88,
                z: r * ph.sin() * th.sin(),
                s: 0.5 + rnd.next() * 1.3,
                h: 0.25 + rnd.next() * 0.5,
                tw: rnd.next() * TAU,
                w: 0.5 + rnd.next() * 1.2,
            });
        }
        let mut rings = Vec::new();
        const N_R: usize = 8;
        for b in 0..N_R {
            let rb = r_max * (0.38 + 0.6 * (b as f32 + rnd.next() * 0.7) / N_R as f32);
            let nx = (rnd.next() - 0.5) * 1.3;
            let ny = (rnd.next() - 0.5) * 1.3;
            let nz = 0.75 + rnd.next() * 0.7;
            let nl = (nx * nx + ny * ny + nz * nz).sqrt();
            let n = [nx / nl, ny / nl, nz / nl];
            let axv = if n[0].abs() > 0.8 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
            let mut u = [
                n[1] * axv[2] - n[2] * axv[1],
                n[2] * axv[0] - n[0] * axv[2],
                n[0] * axv[1] - n[1] * axv[0],
            ];
            let ul = (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt();
            u = [u[0] / ul, u[1] / ul, u[2] / ul];
            let v = [
                n[1] * u[2] - n[2] * u[1],
                n[2] * u[0] - n[0] * u[2],
                n[0] * u[1] - n[1] * u[0],
            ];
            let w = (0.1 + rnd.next() * 0.35) * if rnd.next() < 0.45 { -1.0 } else { 1.0 };
            let h = 0.35 + rnd.next() * 0.45;
            let lw = 0.5 + rnd.next() * 1.1;
            let n_seg = 2 + (rnd.next() * 4.0) as usize;
            let mut segs = Vec::new();
            for _ in 0..n_seg {
                segs.push(Seg {
                    a0: rnd.next() * TAU,
                    len: 0.2 + rnd.next() * 1.3,
                    al: 0.1 + rnd.next() * 0.3,
                });
            }
            let n_deb = (size * 0.16 + rnd.next() * size * 0.1).round() as usize;
            let mut deb = Vec::new();
            for _ in 0..n_deb {
                let sg = &segs[(rnd.next() * n_seg as f32) as usize % n_seg];
                deb.push(Deb {
                    a: sg.a0 + rnd.next() * sg.len * 1.3 - sg.len * 0.15,
                    rr: rb + (rnd.next() - 0.5) * r_max * 0.07,
                    s: 0.5 + rnd.next() * 1.4,
                    h: 0.35 + rnd.next() * 0.55,
                    tw: rnd.next() * TAU,
                    w: 0.8 + rnd.next() * 1.6,
                });
            }
            rings.push(Ring { rb, u, v, w, h, lw, segs, deb });
        }
        Self { size, dots, rings }
    }

    /// Draw at wall-clock `t` (flicker/pulse timing) and accumulated
    /// `motion_t` (spin phase). Integrate `motion_t += dt * spd` upstream:
    /// spin speed changes then glide instead of rescaling the whole phase
    /// history (the old `t * spd` made the orb whip around on transitions).
    pub fn paint_params(
        &self,
        painter: &Painter,
        rect: Rect,
        t: f32,
        motion_t: f32,
        p: &OrbParams,
        glow: f32,
    ) {
        let pal = Palette { e: p.e, hh: p.hh };
        let scale = rect.width() / self.size;
        let r_max = self.size / 2.0;
        let glow = glow.max(0.2);

        let ramp = |q: f32, a: f32| -> Color32 {
            let w = q.min(1.0) * q.min(1.0);
            Color32::from_rgba_unmultiplied(
                (pal.e[0] + (pal.hh[0] - pal.e[0]) * w) as u8,
                (pal.e[1] + (pal.hh[1] - pal.e[1]) * w) as u8,
                (pal.e[2] + (pal.hh[2] - pal.e[2]) * w) as u8,
                (a.min(1.0) * 255.0) as u8,
            )
        };
        let to_screen = |x: f32, y: f32| -> Pos2 {
            Pos2::new(rect.left() + x * scale, rect.top() + y * scale)
        };

        // Spin + fixed tilt projection (design: rotY(ay) then rotX(0.33)).
        let ay = 0.45 * motion_t;
        let (sa, ca) = ay.sin_cos();
        let (st2, ct2) = 0.33f32.sin_cos();
        let proj = |x: f32, y: f32, z: f32| -> (f32, f32, f32, f32) {
            let x1 = x * ca + z * sa;
            let z1 = -x * sa + z * ca;
            let y2 = y * ct2 - z1 * st2;
            let z2 = y * st2 + z1 * ct2;
            let pr = 1.0 / (1.0 - z2 / (r_max * 3.2));
            (r_max + x1 * pr, r_max + y2 * pr, z2, pr)
        };

        // Soft outer halo (design: blurred radial backdrop).
        radial_fan(
            painter,
            to_screen(r_max, r_max),
            r_max * scale,
            &[(0.0, ramp(0.35, 0.05 * glow)), (1.0, ramp(0.3, 0.0))],
        );

        // Debris rings: arc segments as polylines + flickering debris squares.
        for rg in &self.rings {
            let a = rg.w * motion_t;
            for sg in &rg.segs {
                const CH: usize = 3;
                const NS: usize = 5;
                for ci in 0..CH {
                    let mut pts = Vec::with_capacity(NS + 1);
                    let mut zsum = 0.0;
                    let mut prsum = 0.0;
                    for si in 0..=NS {
                        let th = sg.a0 + a + sg.len * (ci as f32 + si as f32 / NS as f32) / CH as f32;
                        let (c1, s1) = (th.cos(), th.sin());
                        let (px, py, pz, pr) = proj(
                            rg.rb * (rg.u[0] * c1 + rg.v[0] * s1),
                            rg.rb * (rg.u[1] * c1 + rg.v[1] * s1),
                            rg.rb * (rg.u[2] * c1 + rg.v[2] * s1),
                        );
                        pts.push(to_screen(px, py));
                        zsum += pz;
                        prsum += pr;
                    }
                    let shade = 0.25 + 0.75 * ((zsum / (NS + 1) as f32) / rg.rb + 1.0) * 0.5;
                    let alpha = sg.al * p.amp * shade * glow.min(1.4);
                    painter.add(egui::Shape::line(
                        pts,
                        Stroke::new(rg.lw * (prsum / (NS + 1) as f32) * scale, ramp(rg.h, alpha)),
                    ));
                }
            }
            for d in &rg.deb {
                let th = d.a + a;
                let (c1, s1) = (th.cos(), th.sin());
                let (px, py, pz, pr) = proj(
                    d.rr * (rg.u[0] * c1 + rg.v[0] * s1),
                    d.rr * (rg.u[1] * c1 + rg.v[1] * s1),
                    d.rr * (rg.u[2] * c1 + rg.v[2] * s1),
                );
                let shade = 0.25 + 0.75 * (pz / d.rr + 1.0) * 0.5;
                let fl = 0.5 + 0.5 * (t * 2.4 * d.w + d.tw).sin();
                let ss = (d.s * pr).max(0.4) * scale;
                let c = ramp(d.h, (0.2 + 0.6 * fl) * p.amp * shade);
                let p = to_screen(px, py);
                painter.rect_filled(Rect::from_center_size(p, egui::vec2(ss, ss)), 0.0, c);
            }
        }

        // Core + volume ember dots.
        for d in &self.dots {
            let (px, py, pz, pr) = proj(d.x, d.y, d.z);
            let rr = (d.x * d.x + d.y * d.y + d.z * d.z).sqrt().max(1.0);
            let shade = 0.3 + 0.7 * (pz / rr + 1.0) * 0.5;
            let fl = 0.55 + 0.45 * (t * 2.0 * d.w + d.tw).sin();
            let ss = (d.s * pr).max(0.4) * scale;
            let c = ramp(d.h, ((0.3 + 0.7 * fl) * shade * p.amp).min(1.0));
            let p = to_screen(px, py);
            painter.rect_filled(Rect::from_center_size(p, egui::vec2(ss, ss)), 0.0, c);
        }

        // White-hot pulsing core flare.
        let pulse = (1.0 + 0.1 * (t * 3.1).sin() + 0.05 * (t * 7.7).sin()) * p.flare;
        let cr = r_max * 0.5 * pulse.max(0.3);
        radial_fan(
            painter,
            to_screen(r_max, r_max),
            cr * scale,
            &[
                (0.0, ramp(1.0, (0.9 * glow).min(1.0))),
                (0.35, ramp(0.62, (0.4 * glow).min(1.0))),
                (0.7, ramp(0.3, (0.13 * glow).min(1.0))),
                (1.0, ramp(0.2, 0.0)),
            ],
        );
    }
}

/// Radial-gradient disc as a triangle-fan mesh (egui has no gradients).
/// Public: the UI reuses it for the background bloom that stands in for
/// backdrop blur (blur of a smooth gradient is the gradient).
pub fn radial_fan(painter: &Painter, center: Pos2, radius: f32, stops: &[(f32, Color32)]) {
    const SEGS: usize = 48;
    let mut mesh = egui::Mesh::default();
    for w in stops.windows(2) {
        let (r0, c0) = w[0];
        let (r1, c1) = w[1];
        let base = mesh.vertices.len() as u32;
        for i in 0..=SEGS {
            let th = i as f32 / SEGS as f32 * TAU;
            let (s, c) = th.sin_cos();
            for &(rr, cc) in &[(r0, c0), (r1, c1)] {
                mesh.vertices.push(egui::epaint::Vertex {
                    pos: Pos2::new(center.x + c * radius * rr, center.y + s * radius * rr),
                    uv: egui::epaint::WHITE_UV,
                    color: cc,
                });
            }
        }
        for i in 0..SEGS as u32 {
            let a = base + i * 2;
            mesh.indices.extend_from_slice(&[a, a + 1, a + 2, a + 1, a + 3, a + 2]);
        }
    }
    painter.add(egui::Shape::mesh(mesh));
}
