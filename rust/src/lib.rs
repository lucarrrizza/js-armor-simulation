//! Multi-threaded particle/bond impact solver compiled to WebAssembly.
//!
//! Every worker instantiates this module on the same shared memory. JavaScript
//! coordinates the phases (see engines/wasm.js); inside a phase, threads claim
//! chunks of work from an atomic counter. All phases are written in "gather"
//! form (each particle only writes its own data) so no locking is needed.
#![no_std]

use core::arch::wasm32;
use core::sync::atomic::{AtomicU32, Ordering::*};

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    wasm32::unreachable()
}

extern "C" {
    static __heap_base: u8;
}

const K: usize = 6; // particle slots per grid cell
const ADJ: usize = 8; // bond slots per particle
const NONE: u32 = u32::MAX;
const MAXT: usize = 64;
const EVCAP: usize = 4096;
const CH_P: usize = 512;
const CH_B: usize = 2048;

// material / constant table written by JS (f64)
const MT_MK: usize = 0;
const MT_MY: usize = 16;
const MT_MFR: usize = 32;
const MT_MCR: usize = 48;
const MT_MMELT: usize = 64;
const MT_MCB: usize = 80;
const MT_MEXP: usize = 96;
const MT_KC: usize = 112;
const MT_CC: usize = 368;
const MT_CONST: usize = 624; // 32 slots: scalar constants (see C_* below)
const MT_MGAS: usize = 656; // per-material flag: detonation products
const MT_MDEN: usize = 672; // per-material flag: SPH density source (explosive or products)
const MT_MMASS: usize = 688; // per-material mass
const MT_LEN: usize = 704;

// offsets inside the MT_CONST block (after the first 11 entries used by contacts/bonds/detonation)
const C_H: usize = 11; // SPH smoothing length
const C_SPHKW: usize = 12; // SPH 2D normalisation
const C_GHI: usize = 13; // GAMMA_HI
const C_GLO: usize = 14; // GAMMA_LO
const C_RHO0: usize = 15;
const C_P0: usize = 16;
const C_RHOC: usize = 17;
const C_PC: usize = 18;
const C_GCUT: usize = 19; // smoke removal threshold (fraction of rho0)
const C_DTOUCH: usize = 20; // detonation front reach
const C_MP: usize = 21; // explosive mass (SPH particle mass)
const C_PROD: usize = 22; // products material index
const C_EXPL: usize = 23; // explosive material index

const LN2: f64 = 0.693_147_180_559_945_3;

// no_std has no powf/ln/exp: small, accurate versions for the gas equation of state.
fn ln(x: f64) -> f64 {
    let bits = x.to_bits();
    let mut e = ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > core::f64::consts::SQRT_2 {
        m *= 0.5;
        e += 1;
    }
    let z = (m - 1.0) / (m + 1.0);
    let z2 = z * z;
    let mut term = z;
    let mut sum = 0.0;
    let mut k = 1.0;
    for _ in 0..12 {
        sum += term / k;
        term *= z2;
        k += 2.0;
    }
    2.0 * sum + e as f64 * LN2
}

fn exp(y: f64) -> f64 {
    let t = y / LN2;
    let k = if t >= 0.0 { (t + 0.5) as i64 } else { (t - 0.5) as i64 };
    let r = y - k as f64 * LN2;
    let mut term = 1.0;
    let mut sum = 1.0;
    for n in 1..25 {
        term *= r / n as f64;
        sum += term;
    }
    sum * f64::from_bits(((k + 1023) as u64) << 52)
}

#[inline(always)]
fn pow(x: f64, y: f64) -> f64 {
    exp(y * ln(x))
}

// SPH cubic spline kernel and its derivative, q = r / H (support 2)
#[inline(always)]
fn kw(q: f64) -> f64 {
    if q < 1.0 {
        1.0 - 1.5 * q * q + 0.75 * q * q * q
    } else if q < 2.0 {
        let t = 2.0 - q;
        0.25 * t * t * t
    } else {
        0.0
    }
}

#[inline(always)]
fn dkw(q: f64) -> f64 {
    if q < 1.0 {
        -3.0 * q + 2.25 * q * q
    } else if q < 2.0 {
        let t = 2.0 - q;
        -0.75 * t * t
    } else {
        0.0
    }
}

struct State {
    n: usize,
    nb: usize,
    nexpl: usize,
    nm: usize,
    gw: i32,
    gh: i32,
    cells: usize,
    gx0: f64,
    gy0: f64,
    bx0: f64,
    bx1: f64,
    by0: f64,
    by1: f64,
    cur: usize,
    dt: f64,
    decay: f32,
    time: f64,
    steps: u32,
    nev: usize,
    px: *mut f64,
    py: *mut f64,
    vx: *mut f64,
    vy: *mut f64,
    fcx: *mut f64,
    fcy: *mut f64,
    invm: *mut f64,
    dett: *mut f64,
    heat: *mut f32,
    stress: *mut f32,
    mat: *mut u8,
    grp: *mut u8,
    alive: *mut u8,
    pcell: *mut i32,
    adj: *mut u32,
    ba: *mut u32,
    bb: *mut u32,
    brest: *mut f64,
    borig: *mut f64,
    bout: *mut f32,
    expl: *mut u32,
    gcnt: *mut AtomicU32,
    gslot: *mut u32,
    mt: *mut f64,
    events: *mut f64,
    v2t: *mut f64,
    scratch: *mut u8,
    order: *mut u32,
    inv: *mut i32,
    tmp: *mut u32,
    layout: *mut u32,
    // gas model scratch: SPH density and pressure per particle, gas force per particle, per-thread max c^2
    rho: *mut f64,
    pr: *mut f64,
    gx: *mut f64,
    gy: *mut f64,
    c2t: *mut f64,
    gas: bool,
    gas_dt: f64,
}

static mut S: State = State {
    n: 0, nb: 0, nexpl: 0, nm: 0, gw: 0, gh: 0, cells: 0,
    gx0: 0.0, gy0: 0.0, bx0: 0.0, bx1: 0.0, by0: 0.0, by1: 0.0,
    cur: 0, dt: 0.0, decay: 1.0, time: 0.0, steps: 0, nev: 0,
    px: 0 as _, py: 0 as _, vx: 0 as _, vy: 0 as _, fcx: 0 as _, fcy: 0 as _, invm: 0 as _, dett: 0 as _,
    heat: 0 as _, stress: 0 as _, mat: 0 as _, grp: 0 as _, alive: 0 as _, pcell: 0 as _, adj: 0 as _,
    ba: 0 as _, bb: 0 as _, brest: 0 as _, borig: 0 as _, bout: 0 as _, expl: 0 as _,
    gcnt: 0 as _, gslot: 0 as _, mt: 0 as _, events: 0 as _, v2t: 0 as _,
    scratch: 0 as _, order: 0 as _, inv: 0 as _, tmp: 0 as _, layout: 0 as _,
    rho: 0 as _, pr: 0 as _, gx: 0 as _, gy: 0 as _, c2t: 0 as _, gas: false, gas_dt: f64::INFINITY,
};

static NEXT: AtomicU32 = AtomicU32::new(0);
static mut HEAP_START: usize = 0;
static mut HEAP_TOP: usize = 0;
static mut CTRL: usize = 0;

#[inline(always)]
fn st() -> &'static mut State {
    unsafe { &mut *core::ptr::addr_of_mut!(S) }
}

#[inline(always)]
fn sqrt(x: f64) -> f64 {
    // scalar f64.sqrt is not exposed on stable without std; LLVM lowers this to a plain sqrt
    wasm32::f64x2_extract_lane::<0>(wasm32::f64x2_sqrt(wasm32::f64x2_splat(x)))
}

#[inline(always)]
fn abs(x: f64) -> f64 {
    f64::from_bits(x.to_bits() & !(1u64 << 63))
}

unsafe fn halloc(bytes: usize) -> *mut u8 {
    let p = (HEAP_TOP + 15) & !15;
    let end = p + bytes;
    let have = wasm32::memory_size(0) * 65536;
    if end > have {
        let pages = (end - have + 65535) / 65536;
        if wasm32::memory_grow(0, pages) == usize::MAX {
            return core::ptr::null_mut();
        }
    }
    HEAP_TOP = end;
    p as *mut u8
}

unsafe fn alloc<T>(count: usize) -> *mut T {
    halloc(count.max(1) * core::mem::size_of::<T>()) as *mut T
}

/// Reserves `stack_total` bytes for worker stacks plus a control block; returns the stack region.
#[no_mangle]
pub unsafe extern "C" fn init_heap(stack_total: usize) -> usize {
    HEAP_TOP = core::ptr::addr_of!(__heap_base) as usize;
    let stacks = halloc(stack_total) as usize;
    CTRL = halloc(64) as usize;
    core::ptr::write_bytes(CTRL as *mut u8, 0, 64);
    HEAP_START = HEAP_TOP;
    stacks
}

#[no_mangle]
pub extern "C" fn ctrl_ptr() -> usize {
    unsafe { CTRL }
}

/// Allocates all arrays for a scene. Returns a pointer to a table of array pointers that JS fills.
#[no_mangle]
pub unsafe extern "C" fn setup(
    n: usize, nb: usize, nexpl: usize, nm: usize, gw: i32, gh: i32,
    bx0: f64, by0: f64, bx1: f64, by1: f64,
) -> usize {
    HEAP_TOP = HEAP_START;
    let s = st();
    s.n = n;
    s.nb = nb;
    s.nexpl = nexpl;
    s.nm = nm;
    s.gw = gw;
    s.gh = gh;
    s.cells = (gw as usize) * (gh as usize);
    s.bx0 = bx0;
    s.by0 = by0;
    s.bx1 = bx1;
    s.by1 = by1;
    s.gx0 = bx0 - 1.0;
    s.gy0 = by0 - 1.0;
    s.cur = 0;
    s.time = 0.0;
    s.steps = 0;
    s.nev = 0;
    s.layout = alloc::<u32>(32);
    s.px = alloc(n);
    s.py = alloc(n);
    s.vx = alloc(n);
    s.vy = alloc(n);
    s.fcx = alloc(n);
    s.fcy = alloc(n);
    s.invm = alloc(n);
    s.dett = alloc(n);
    s.heat = alloc(n);
    s.stress = alloc(n);
    s.mat = alloc(n);
    s.grp = alloc(n);
    s.alive = alloc(n);
    s.pcell = alloc(n);
    s.adj = alloc(n * ADJ);
    s.ba = alloc(nb);
    s.bb = alloc(nb);
    s.brest = alloc(nb);
    s.borig = alloc(nb);
    s.bout = alloc(nb * 4);
    s.expl = alloc(nexpl);
    s.gcnt = alloc(2 * s.cells);
    s.gslot = alloc(2 * s.cells * K);
    s.mt = alloc(MT_LEN);
    s.events = alloc(EVCAP * 3);
    s.v2t = alloc(MAXT);
    s.rho = alloc(n);
    s.pr = alloc(n);
    s.gx = alloc(n);
    s.gy = alloc(n);
    s.c2t = alloc(MAXT);
    s.gas = false;
    s.gas_dt = f64::INFINITY;
    s.scratch = alloc::<f64>(n) as *mut u8;
    s.order = alloc(n);
    s.inv = alloc(n);
    s.tmp = alloc(s.cells + 2);
    if s.tmp.is_null() {
        return 0;
    }
    let l = s.layout;
    let ptrs: [usize; 18] = [
        s.px as usize, s.py as usize, s.vx as usize, s.vy as usize, s.invm as usize, s.dett as usize,
        s.heat as usize, s.stress as usize, s.mat as usize, s.grp as usize, s.alive as usize,
        s.ba as usize, s.bb as usize, s.brest as usize, s.borig as usize, s.expl as usize,
        s.mt as usize, s.events as usize,
    ];
    for (k, p) in ptrs.iter().enumerate() {
        *l.add(k) = *p as u32;
    }
    l as usize
}

/// Called after JS has filled the arrays: clears the grids and builds adjacency + grid.
#[no_mangle]
pub unsafe extern "C" fn finalize() {
    let s = st();
    core::ptr::write_bytes(s.gcnt as *mut u32, 0, 2 * s.cells);
    for i in 0..s.n {
        *s.pcell.add(i) = -1;
        *s.stress.add(i) = 0.0;
    }
    reorder();
}

#[inline(always)]
unsafe fn cell_of(s: &State, x: f64, y: f64) -> i32 {
    ((x - s.gx0) as i32) + ((y - s.gy0) as i32) * s.gw
}

/// Sorts particles into grid order (cache locality), drops dead particles and broken bonds,
/// rebuilds bond adjacency and re-inserts everything into the current grid.
unsafe fn reorder() {
    let s = st();
    let n = s.n;
    let g = s.cur * s.cells;
    for i in 0..n {
        let c = *s.pcell.add(i);
        if c >= 0 {
            (*s.gcnt.add(g + c as usize)).store(0, Relaxed);
        }
    }
    // counting sort of alive particles by cell
    let mut cmin = i32::MAX;
    let mut cmax = -1i32;
    for i in 0..n {
        if *s.alive.add(i) == 0 {
            *s.pcell.add(i) = -1;
            continue;
        }
        let c = cell_of(s, *s.px.add(i), *s.py.add(i));
        *s.pcell.add(i) = c;
        if c < cmin { cmin = c; }
        if c > cmax { cmax = c; }
    }
    let mut m = 0usize;
    if cmax >= cmin {
        let range = (cmax - cmin + 1) as usize;
        let t = s.tmp;
        core::ptr::write_bytes(t, 0, range + 1);
        for i in 0..n {
            let c = *s.pcell.add(i);
            if c >= 0 {
                *t.add((c - cmin) as usize + 1) += 1;
            }
        }
        for k in 0..range {
            *t.add(k + 1) += *t.add(k);
        }
        for i in 0..n {
            let c = *s.pcell.add(i);
            if c >= 0 {
                let slot = t.add((c - cmin) as usize);
                *s.order.add(*slot as usize) = i as u32;
                *slot += 1;
            }
        }
        m = *t.add(range) as usize;
    }
    for i in 0..n {
        *s.inv.add(i) = -1;
    }
    for k in 0..m {
        *s.inv.add(*s.order.add(k) as usize) = k as i32;
    }
    permute(s.px, m);
    permute(s.py, m);
    permute(s.vx, m);
    permute(s.vy, m);
    permute(s.invm, m);
    permute(s.dett, m);
    permute(s.heat, m);
    permute(s.stress, m);
    permute(s.mat, m);
    permute(s.grp, m);
    permute(s.alive, m);
    s.n = m;

    // compact bonds
    let mut w = 0usize;
    for b in 0..s.nb {
        if *s.borig.add(b) < 0.0 {
            continue;
        }
        let i = *s.inv.add(*s.ba.add(b) as usize);
        let j = *s.inv.add(*s.bb.add(b) as usize);
        if i < 0 || j < 0 {
            continue;
        }
        *s.ba.add(w) = i as u32;
        *s.bb.add(w) = j as u32;
        *s.brest.add(w) = *s.brest.add(b);
        *s.borig.add(w) = *s.borig.add(b);
        w += 1;
    }
    s.nb = w;
    core::ptr::write_bytes(s.bout, 0, w * 4);
    for k in 0..m * ADJ {
        *s.adj.add(k) = NONE;
    }
    for b in 0..w {
        add_adj(s, *s.ba.add(b) as usize, (b as u32) << 1);
        add_adj(s, *s.bb.add(b) as usize, ((b as u32) << 1) | 1);
    }

    let mut e = 0usize;
    for k in 0..s.nexpl {
        let i = *s.inv.add(*s.expl.add(k) as usize);
        if i >= 0 {
            *s.expl.add(e) = i as u32;
            e += 1;
        }
    }
    s.nexpl = e;

    for i in 0..m {
        let c = cell_of(s, *s.px.add(i), *s.py.add(i));
        insert(s, g, c, i);
        *s.pcell.add(i) = c;
    }
}

#[inline(always)]
unsafe fn insert(s: &State, g: usize, c: i32, i: usize) {
    let cc = g + c as usize;
    let slot = (*s.gcnt.add(cc)).fetch_add(1, Relaxed) as usize;
    if slot < K {
        *s.gslot.add(cc * K + slot) = i as u32;
    }
}

unsafe fn add_adj(s: &State, i: usize, e: u32) {
    let a = s.adj.add(i * ADJ);
    for k in 0..ADJ {
        if *a.add(k) == NONE {
            *a.add(k) = e;
            return;
        }
    }
}

unsafe fn permute<T: Copy>(arr: *mut T, m: usize) {
    let s = st();
    let tmp = s.scratch as *mut T;
    for k in 0..m {
        *tmp.add(k) = *arr.add(*s.order.add(k) as usize);
    }
    core::ptr::copy_nonoverlapping(tmp, arr, m);
}

/// Start of a substep (main thread only).
#[no_mangle]
pub unsafe extern "C" fn step_begin(dt: f64, decay: f64) {
    let s = st();
    if s.steps > 0 && s.steps % 64 == 0 {
        reorder();
    }
    s.dt = dt;
    s.decay = decay as f32;
}

/// Must be called by the coordinator before releasing the workers into phase `p`.
#[no_mangle]
pub unsafe extern "C" fn phase_begin(p: u32) {
    let s = st();
    if p == 2 {
        for t in 0..MAXT {
            *s.v2t.add(t) = 0.0;
        }
    }
    if p == 3 {
        for t in 0..MAXT {
            *s.c2t.add(t) = 0.0;
        }
    }
    NEXT.store(0, SeqCst);
}

/// Process chunks of phase `p` until none are left. Called by every thread.
#[no_mangle]
pub unsafe extern "C" fn work(p: u32, tid: u32) {
    let s = st();
    if (p == 3 || p == 4) && !s.gas {
        return;
    }
    let (total, ch) = if p == 1 { (s.nb, CH_B) } else { (s.n, CH_P) };
    let mut v2 = 0.0f64;
    let mut c2 = 0.0f64;
    loop {
        let lo = NEXT.fetch_add(1, Relaxed) as usize * ch;
        if lo >= total {
            break;
        }
        let hi = if lo + ch < total { lo + ch } else { total };
        match p {
            0 => contacts(s, lo, hi),
            1 => bonds(s, lo, hi),
            2 => {
                let v = integrate(s, lo, hi);
                if v > v2 {
                    v2 = v;
                }
            }
            3 => {
                let c = gas_density(s, lo, hi);
                if c > c2 {
                    c2 = c;
                }
            }
            _ => gas_force(s, lo, hi),
        }
    }
    if p == 2 {
        *s.v2t.add(tid as usize % MAXT) = v2;
    }
    if p == 3 {
        *s.c2t.add(tid as usize % MAXT) = c2;
    }
}

/// End of a substep (main thread only): swaps grids, runs detonations; returns max speed.
#[no_mangle]
pub unsafe extern "C" fn step_end() -> f64 {
    let s = st();
    let mut v2 = 0.0f64;
    for t in 0..MAXT {
        let v = *s.v2t.add(t);
        if v > v2 {
            v2 = v;
        }
    }
    s.cur = 1 - s.cur;
    s.time += s.dt;
    s.steps += 1;
    if s.gas {
        let mut c2 = 0.0f64;
        for t in 0..MAXT {
            let c = *s.c2t.add(t);
            if c > c2 {
                c2 = c;
            }
        }
        s.gas_dt = if c2 > 0.0 { 0.4 * *s.mt.add(MT_CONST + C_H) / sqrt(c2) } else { f64::INFINITY };
    }
    if s.nexpl > 0 {
        if s.gas {
            detonations_gas(s);
        } else {
            detonations(s);
        }
    }
    sqrt(v2)
}

#[inline(always)]
unsafe fn in_grid(s: &State, cc: usize, i: usize) -> bool {
    let cnt = ((*s.gcnt.add(cc)).load(Relaxed) as usize).min(K);
    let slots = s.gslot.add(cc * K);
    (0..cnt).any(|q| *slots.add(q) as usize == i)
}

unsafe fn contacts(s: &State, lo: usize, hi: usize) {
    let mt = s.mt;
    let r0 = *mt.add(MT_CONST);
    let r0sq = r0 * r0;
    let heat_v = *mt.add(MT_CONST + 1);
    let heat_k = *mt.add(MT_CONST + 2) * s.dt;
    let friction = *mt.add(MT_CONST + 6);
    let g = s.cur * s.cells;
    let gw = s.gw as isize;
    let nm = s.nm;
    for i in lo..hi {
        if *s.alive.add(i) == 0 {
            continue;
        }
        // detonation products take no contact forces (gas model)
        if *mt.add(MT_MGAS + *s.mat.add(i) as usize) != 0.0 {
            *s.fcx.add(i) = 0.0;
            *s.fcy.add(i) = 0.0;
            continue;
        }
        let c = *s.pcell.add(i);
        if c < 0 || !in_grid(s, g + c as usize, i) {
            // overflowed its cell: neighbours can't see it, so it must not push them either
            continue;
        }
        let xi = *s.px.add(i);
        let yi = *s.py.add(i);
        let vxi = *s.vx.add(i);
        let vyi = *s.vy.add(i);
        let mi = *s.mat.add(i) as usize * nm;
        let mut fx = 0.0f64;
        let mut fy = 0.0f64;
        let mut h = 0.0f64;
        for dy in [-gw, 0, gw] {
            for dx in [-1isize, 0, 1] {
                let cc = (g as isize + c as isize + dy + dx) as usize;
                let mut cnt = (*s.gcnt.add(cc)).load(Relaxed) as usize;
                if cnt > K {
                    cnt = K;
                }
                let slots = s.gslot.add(cc * K);
                for q in 0..cnt {
                    let j = *slots.add(q) as usize;
                    if j == i || *s.alive.add(j) == 0 || *mt.add(MT_MGAS + *s.mat.add(j) as usize) != 0.0 {
                        continue;
                    }
                    let ddx = *s.px.add(j) - xi;
                    let ddy = *s.py.add(j) - yi;
                    let d2 = ddx * ddx + ddy * ddy;
                    if d2 >= r0sq || d2 < 1e-12 {
                        continue;
                    }
                    let d = sqrt(d2);
                    let nx = ddx / d;
                    let ny = ddy / d;
                    let ov = r0 - d;
                    let pk = mi + *s.mat.add(j) as usize;
                    let kc = *mt.add(MT_KC + pk);
                    let cc_ = *mt.add(MT_CC + pk);
                    let rvx = *s.vx.add(j) - vxi;
                    let rvy = *s.vy.add(j) - vyi;
                    let vn = rvx * nx + rvy * ny;
                    let mut f = kc * ov * (1.0 + 8.0 * ov * ov);
                    if vn < 0.0 {
                        f -= cc_ * vn;
                        let hs = -vn - heat_v;
                        if hs > 0.0 {
                            h += hs * heat_k;
                        }
                    }
                    let tvx = rvx - vn * nx;
                    let tvy = rvy - vn * ny;
                    let tv = sqrt(tvx * tvx + tvy * tvy);
                    let mut tx = 0.0;
                    let mut ty = 0.0;
                    if tv > 1e-6 {
                        let mut ft = cc_ * tv;
                        let lim = friction * abs(f);
                        if lim < ft {
                            ft = lim;
                        }
                        tx = ft * tvx / tv;
                        ty = ft * tvy / tv;
                    }
                    fx -= f * nx - tx;
                    fy -= f * ny - ty;
                }
            }
        }
        *s.fcx.add(i) = fx;
        *s.fcy.add(i) = fy;
        *s.heat.add(i) += h as f32;
    }
}

unsafe fn bonds(s: &State, lo: usize, hi: usize) {
    let mt = s.mt;
    let plastic_heat = *mt.add(MT_CONST + 3);
    let min_rest = *mt.add(MT_CONST + 4);
    let break_heat = *mt.add(MT_CONST + 5) as f32;
    for b in lo..hi {
        let out = s.bout.add(b * 4);
        let o = *s.borig.add(b);
        if o < 0.0 {
            if *out.add(3) >= 0.0 {
                *out = 0.0;
                *out.add(1) = 0.0;
                *out.add(2) = 0.0;
                *out.add(3) = -1.0;
            }
            continue;
        }
        let i = *s.ba.add(b) as usize;
        let j = *s.bb.add(b) as usize;
        // bonds touching detonation products are removed (gas model)
        if *s.alive.add(i) == 0 || *s.alive.add(j) == 0
            || *mt.add(MT_MGAS + *s.mat.add(i) as usize) != 0.0
            || *mt.add(MT_MGAS + *s.mat.add(j) as usize) != 0.0
        {
            *s.borig.add(b) = -1.0;
            *out = 0.0;
            *out.add(1) = 0.0;
            *out.add(2) = 0.0;
            *out.add(3) = -1.0;
            continue;
        }
        let m = *s.mat.add(i) as usize;
        let ddx = *s.px.add(j) - *s.px.add(i);
        let ddy = *s.py.add(j) - *s.py.add(i);
        let len = sqrt(ddx * ddx + ddy * ddy) + 1e-12;
        let tot = (len - o) / o;
        let mfr = *mt.add(MT_MFR + m);
        let melt = *mt.add(MT_MMELT + m) as f32;
        if tot > mfr || -tot > *mt.add(MT_MCR + m) || *s.heat.add(i) > melt || *s.heat.add(j) > melt {
            *s.borig.add(b) = -1.0;
            *out = 0.0;
            *out.add(1) = 0.0;
            *out.add(2) = break_heat;
            *out.add(3) = 0.0;
            continue;
        }
        let mut r = *s.brest.add(b);
        let y = *mt.add(MT_MY + m) * o;
        let mut h = 0.0f64;
        if len - r > y {
            let nr = len - y;
            h = (nr - r) * plastic_heat;
            r = nr;
        } else if r - len > y && r > min_rest * o {
            let mut nr = len + y;
            if nr < min_rest * o {
                nr = min_rest * o;
            }
            h = (r - nr) * plastic_heat;
            r = nr;
        }
        *s.brest.add(b) = r;
        let nx = ddx / len;
        let ny = ddy / len;
        let vn = (*s.vx.add(j) - *s.vx.add(i)) * nx + (*s.vy.add(j) - *s.vy.add(i)) * ny;
        let f = *mt.add(MT_MK + m) * (len - r) + *mt.add(MT_MCB + m) * vn;
        *out = (f * nx) as f32;
        *out.add(1) = (f * ny) as f32;
        *out.add(2) = h as f32;
        *out.add(3) = (abs(tot) / mfr) as f32;
    }
}

unsafe fn integrate(s: &State, lo: usize, hi: usize) -> f64 {
    let dt = s.dt;
    let decay = s.decay;
    let gc = s.cur * s.cells;
    let gn = (1 - s.cur) * s.cells;
    let mut v2max = 0.0f64;
    for i in lo..hi {
        let old = *s.pcell.add(i);
        if old >= 0 {
            (*s.gcnt.add(gc + old as usize)).store(0, Relaxed);
        }
        if *s.alive.add(i) == 0 {
            *s.pcell.add(i) = -1;
            continue;
        }
        let mut fx = *s.fcx.add(i);
        let mut fy = *s.fcy.add(i);
        if s.gas {
            fx += *s.gx.add(i);
            fy += *s.gy.add(i);
        }
        let mut hb = 0.0f32;
        let mut smax = 0.0f32;
        let a = s.adj.add(i * ADJ);
        for k in 0..ADJ {
            let e = *a.add(k);
            if e == NONE {
                break;
            }
            let out = s.bout.add((e >> 1) as usize * 4);
            let w = *out.add(3);
            if w < 0.0 {
                continue;
            }
            if e & 1 == 0 {
                fx += *out as f64;
                fy += *out.add(1) as f64;
            } else {
                fx -= *out as f64;
                fy -= *out.add(1) as f64;
            }
            hb += *out.add(2);
            if w > smax {
                smax = w;
            }
        }
        *s.stress.add(i) = smax;
        let h = (*s.heat.add(i) + hb) * decay;
        *s.heat.add(i) = if h > 2.0 { 2.0 } else { h };
        let im = *s.invm.add(i);
        if im == 0.0 {
            *s.vx.add(i) = 0.0;
            *s.vy.add(i) = 0.0;
        } else {
            let vx = *s.vx.add(i) + fx * im * dt;
            let vy = *s.vy.add(i) + fy * im * dt;
            *s.vx.add(i) = vx;
            *s.vy.add(i) = vy;
            let x = *s.px.add(i) + vx * dt;
            let y = *s.py.add(i) + vy * dt;
            *s.px.add(i) = x;
            *s.py.add(i) = y;
            let v2 = vx * vx + vy * vy;
            if v2 > v2max {
                v2max = v2;
            }
            if !(x >= s.bx0 && x <= s.bx1 && y >= s.by0 && y <= s.by1) || v2 != v2 {
                *s.alive.add(i) = 0;
                *s.pcell.add(i) = -1;
                continue;
            }
        }
        let c = cell_of(s, *s.px.add(i), *s.py.add(i));
        insert(s, gn, c, i);
        *s.pcell.add(i) = c;
    }
    v2max
}

unsafe fn detonations(s: &mut State) {
    let mt = s.mt;
    let det_heat = *mt.add(MT_CONST + 7) as f32;
    let det_speed = *mt.add(MT_CONST + 8);
    let blast_r = *mt.add(MT_CONST + 9);
    let blast_j = *mt.add(MT_CONST + 10);
    let now = s.time;
    let g = s.cur * s.cells;
    // collect the particles that fire this step (reuse `order` as scratch)
    let mut nf = 0usize;
    for k in 0..s.nexpl {
        let i = *s.expl.add(k) as usize;
        if *s.alive.add(i) == 0 {
            continue;
        }
        if *s.heat.add(i) > det_heat && *s.dett.add(i) > now {
            *s.dett.add(i) = now;
        }
        if *s.dett.add(i) <= now {
            *s.order.add(nf) = i as u32;
            nf += 1;
        }
    }
    for f in 0..nf {
        let i = *s.order.add(f) as usize;
        *s.alive.add(i) = 0;
        let xi = *s.px.add(i);
        let yi = *s.py.add(i);
        let ci = (xi - s.gx0) as i32;
        let cj = (yi - s.gy0) as i32;
        for dy in -3..=3 {
            for dx in -3..=3 {
                let x = ci + dx;
                let y = cj + dy;
                if x < 0 || y < 0 || x >= s.gw || y >= s.gh {
                    continue;
                }
                let cc = g + (x + y * s.gw) as usize;
                let mut cnt = (*s.gcnt.add(cc)).load(Relaxed) as usize;
                if cnt > K {
                    cnt = K;
                }
                for q in 0..cnt {
                    let j = *s.gslot.add(cc * K + q) as usize;
                    if *s.alive.add(j) == 0 {
                        continue;
                    }
                    let ddx = *s.px.add(j) - xi;
                    let ddy = *s.py.add(j) - yi;
                    let d = sqrt(ddx * ddx + ddy * ddy);
                    if d > blast_r || d < 1e-6 {
                        continue;
                    }
                    if *mt.add(MT_MEXP + *s.mat.add(j) as usize) != 0.0 {
                        let t = now + d / det_speed;
                        if t < *s.dett.add(j) {
                            *s.dett.add(j) = t;
                        }
                    } else {
                        let jm = blast_j * (1.0 - d / blast_r) * *s.invm.add(j);
                        *s.vx.add(j) += jm * ddx / d;
                        *s.vy.add(j) += jm * ddy / d;
                        *s.heat.add(j) += (0.15 * (1.0 - d / blast_r)) as f32;
                    }
                }
            }
        }
        if i & 3 == 0 && s.nev < EVCAP {
            let e = s.events.add(s.nev * 3);
            *e = xi;
            *e.add(1) = yi;
            *e.add(2) = now;
            s.nev += 1;
        }
    }
}

/// Visits every grid entry (alive particle) within `r` cells of (x, y), including the particle itself.
#[inline(always)]
unsafe fn stencil(s: &State, x: f64, y: f64, r: i32, mut f: impl FnMut(usize)) {
    let g = s.cur * s.cells;
    let ci = (x - s.gx0) as i32;
    let cj = (y - s.gy0) as i32;
    for dy in -r..=r {
        let yy = cj + dy;
        if yy < 0 || yy >= s.gh {
            continue;
        }
        for dx in -r..=r {
            let xx = ci + dx;
            if xx < 0 || xx >= s.gw {
                continue;
            }
            let cc = g + (xx + yy * s.gw) as usize;
            let cnt = ((*s.gcnt.add(cc)).load(Relaxed) as usize).min(K);
            let slots = s.gslot.add(cc * K);
            for q in 0..cnt {
                f(*slots.add(q) as usize);
            }
        }
    }
}

/// Gas equation of state (mirrors pressure() in sim.js).
#[inline(always)]
unsafe fn gas_pressure(s: &State, rho: f64) -> f64 {
    let mt = s.mt;
    let rhoc = *mt.add(MT_CONST + C_RHOC);
    if rho >= rhoc {
        let q = rho / *mt.add(MT_CONST + C_RHO0);
        *mt.add(MT_CONST + C_P0) * q * q * q
    } else {
        let q = rho / rhoc;
        *mt.add(MT_CONST + C_PC) * pow(q, *mt.add(MT_CONST + C_GLO))
    }
}

/// SPH density, pressure, sound speed and smoke removal for detonation products (phase 3).
/// Returns the largest c^2 seen in [lo, hi).
unsafe fn gas_density(s: &State, lo: usize, hi: usize) -> f64 {
    let mt = s.mt;
    let h = *mt.add(MT_CONST + C_H);
    let h2 = 4.0 * h * h;
    let sphkw = *mt.add(MT_CONST + C_SPHKW);
    let mp = *mt.add(MT_CONST + C_MP);
    let rhoc = *mt.add(MT_CONST + C_RHOC);
    let ghi = *mt.add(MT_CONST + C_GHI);
    let glo = *mt.add(MT_CONST + C_GLO);
    let gcut = *mt.add(MT_CONST + C_GCUT) * *mt.add(MT_CONST + C_RHO0);
    let mut c2max = 0.0f64;
    for i in lo..hi {
        if *s.alive.add(i) == 0 || *mt.add(MT_MGAS + *s.mat.add(i) as usize) == 0.0 {
            continue;
        }
        let xi = *s.px.add(i);
        let yi = *s.py.add(i);
        // the particle's own kernel value kw(0) = 1 is counted here, so it is skipped below
        let mut sum = 1.0f64;
        stencil(s, xi, yi, 3, |j| {
            if j == i || *mt.add(MT_MDEN + *s.mat.add(j) as usize) == 0.0 {
                return;
            }
            let ex = *s.px.add(j) - xi;
            let ey = *s.py.add(j) - yi;
            let d2 = ex * ex + ey * ey;
            if d2 < h2 {
                sum += kw(sqrt(d2) / h);
            }
        });
        let r = mp * sum * sphkw;
        *s.rho.add(i) = r;
        let p = gas_pressure(s, r);
        *s.pr.add(i) = p;
        let c2 = (if r >= rhoc { ghi } else { glo }) * p / r;
        if c2 > c2max {
            c2max = c2;
        }
        if r < gcut {
            *s.alive.add(i) = 0;
        }
    }
    c2max
}

/// SPH pair forces (phase 4). Gather form of the scatter loop in sim.js sph(): every alive
/// product pushes each alive neighbour, and non-product neighbours get the reaction force.
unsafe fn gas_force(s: &State, lo: usize, hi: usize) {
    let mt = s.mt;
    let h = *mt.add(MT_CONST + C_H);
    let h2 = 4.0 * h * h;
    let sphkw = *mt.add(MT_CONST + C_SPHKW);
    let mp = *mt.add(MT_CONST + C_MP);
    for i in lo..hi {
        *s.gx.add(i) = 0.0;
        *s.gy.add(i) = 0.0;
        if *s.alive.add(i) == 0 {
            continue;
        }
        let xi = *s.px.add(i);
        let yi = *s.py.add(i);
        let mi = *s.mat.add(i) as usize;
        let self_gas = *mt.add(MT_MGAS + mi) != 0.0;
        let s_self = if self_gas { *s.pr.add(i) / (*s.rho.add(i) * *s.rho.add(i)) } else { 0.0 };
        let m_self = *mt.add(MT_MMASS + mi);
        let mut fx = 0.0f64;
        let mut fy = 0.0f64;
        stencil(s, xi, yi, 3, |j| {
            if j == i || *s.alive.add(j) == 0 {
                return;
            }
            let mj = *s.mat.add(j) as usize;
            let j_gas = *mt.add(MT_MGAS + mj) != 0.0;
            // a non-product only receives forces from products
            if !self_gas && !j_gas {
                return;
            }
            let ex = *s.px.add(j) - xi;
            let ey = *s.py.add(j) - yi;
            let d2 = ex * ex + ey * ey;
            if d2 >= h2 || d2 < 1e-12 {
                return;
            }
            let d = sqrt(d2);
            let dwdr = sphkw * dkw(d / h) / h; // <= 0
            let sj = if j_gas { *s.pr.add(j) / (*s.rho.add(j) * *s.rho.add(j)) } else { 0.0 };
            let k = if self_gas {
                mp * *mt.add(MT_MMASS + mj) * (s_self + sj) * dwdr / d
            } else {
                mp * m_self * sj * dwdr / d
            };
            fx += k * ex;
            fy += k * ey;
        });
        *s.gx.add(i) = fx;
        *s.gy.add(i) = fy;
    }
}

/// Gas model detonation (mirrors detonationsGas() in sim.js): a fired explosive becomes
/// detonation products and stays in the simulation; the front only spreads to touching explosive.
unsafe fn detonations_gas(s: &mut State) {
    let mt = s.mt;
    let det_heat = *mt.add(MT_CONST + 7) as f32;
    let det_speed = *mt.add(MT_CONST + 8);
    let dtouch = *mt.add(MT_CONST + C_DTOUCH);
    let prod = *mt.add(MT_CONST + C_PROD) as u8;
    let expl = *mt.add(MT_CONST + C_EXPL) as u8;
    let now = s.time;
    let mut nf = 0usize;
    for k in 0..s.nexpl {
        let i = *s.expl.add(k) as usize;
        if *s.alive.add(i) == 0 || *s.mat.add(i) != expl {
            continue;
        }
        if *s.heat.add(i) > det_heat && *s.dett.add(i) > now {
            *s.dett.add(i) = now;
        }
        if *s.dett.add(i) <= now {
            *s.order.add(nf) = i as u32;
            nf += 1;
        }
    }
    for f in 0..nf {
        let i = *s.order.add(f) as usize;
        *s.mat.add(i) = prod;
        *s.invm.add(i) = 1.0 / *mt.add(MT_MMASS + prod as usize);
        let xi = *s.px.add(i);
        let yi = *s.py.add(i);
        let dett = s.dett;
        let mat = s.mat;
        let alive = s.alive;
        let px = s.px;
        let py = s.py;
        stencil(s, xi, yi, 2, |j| {
            if *alive.add(j) == 0 || *mat.add(j) != expl {
                return;
            }
            let ddx = *px.add(j) - xi;
            let ddy = *py.add(j) - yi;
            let d = sqrt(ddx * ddx + ddy * ddy);
            if d > dtouch || d < 1e-6 {
                return;
            }
            let t = now + d / det_speed;
            if t < *dett.add(j) {
                *dett.add(j) = t;
            }
        });
        if i & 3 == 0 && s.nev < EVCAP {
            let e = s.events.add(s.nev * 3);
            *e = xi;
            *e.add(1) = yi;
            *e.add(2) = now;
            s.nev += 1;
        }
    }
    // drop burnt-out explosives from the candidate list
    let mut w = 0usize;
    for k in 0..s.nexpl {
        let i = *s.expl.add(k) as usize;
        if *s.alive.add(i) != 0 && *s.mat.add(i) == expl {
            *s.expl.add(w) = i as u32;
            w += 1;
        }
    }
    s.nexpl = w;
}

#[no_mangle]
pub extern "C" fn get_gas_dt() -> f64 {
    st().gas_dt
}

#[no_mangle]
pub extern "C" fn set_gas(on: u32) {
    st().gas = on != 0;
}

#[no_mangle]
pub extern "C" fn get_n() -> usize {
    st().n
}

#[no_mangle]
pub extern "C" fn get_nb() -> usize {
    st().nb
}

#[no_mangle]
pub extern "C" fn get_time() -> f64 {
    st().time
}

#[no_mangle]
pub extern "C" fn take_events() -> usize {
    let s = st();
    let n = s.nev;
    s.nev = 0;
    n
}
