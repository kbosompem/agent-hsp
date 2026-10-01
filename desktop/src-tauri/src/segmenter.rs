// Speech segmenter. Pure logic, no audio device or Tauri, so the latency
// harness (examples/latency.rs) drives exactly the code the app runs.
//
// Positions are absolute sample counts at 16 kHz since capture started.

pub const SR: u64 = 16000;

#[derive(Clone, Copy, Debug)]
pub struct SegConfig {
    /// Emit partial transcription jobs while the speaker is still talking.
    pub partials: bool,
    /// New audio needed before the next partial job.
    pub partial_step: u64,
    /// Partials transcribe at most this much trailing audio.
    pub partial_window: u64,
    /// Silence that closes a segment.
    pub silence_end: u64,
    /// Segments are force-closed at this length.
    pub max_segment: u64,
}

impl SegConfig {
    /// Behaviour before streaming: transcribe only after 1 s of silence.
    pub fn legacy() -> SegConfig {
        SegConfig {
            partials: false,
            partial_step: 0,
            partial_window: 0,
            silence_end: SR,
            max_segment: 25 * SR,
        }
    }

    pub fn streaming() -> SegConfig {
        SegConfig {
            partials: true,
            partial_step: SR / 2,
            partial_window: 8 * SR,
            silence_end: SR * 7 / 10,
            max_segment: 15 * SR,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Job {
    Partial { start: u64, end: u64, seg: u64 },
    Final { start: u64, end: u64, seg: u64 },
}

pub struct Segmenter {
    pub cfg: SegConfig,
    pub floor: f32,
    seg_start: Option<u64>,
    last_voiced: u64,
    last_partial: u64,
}

impl Segmenter {
    pub fn new(cfg: SegConfig, floor: f32) -> Segmenter {
        Segmenter {
            cfg,
            floor,
            seg_start: None,
            last_voiced: 0,
            last_partial: 0,
        }
    }

    /// `tail_rms` is the level of the last half second; `total` is the
    /// absolute sample position it ends at.
    pub fn step(&mut self, tail_rms: f32, total: u64) -> Option<Job> {
        let threshold_now = (self.floor * 3.0).max(0.0035);
        if tail_rms < self.floor {
            self.floor = tail_rms;
        } else if tail_rms <= threshold_now {
            self.floor = self.floor * 0.999 + tail_rms * 0.001;
        }
        let threshold = (self.floor * 3.0).max(0.0035);
        let voiced = tail_rms > threshold;

        if voiced {
            self.last_voiced = total;
            let ss = match self.seg_start {
                Some(ss) => ss,
                None => {
                    let ss = total.saturating_sub(SR / 2);
                    self.seg_start = Some(ss);
                    self.last_partial = ss;
                    ss
                }
            };
            if total - ss >= self.cfg.max_segment {
                self.seg_start = Some(total);
                self.last_partial = total;
                return Some(Job::Final { start: ss, end: total, seg: ss });
            }
        } else if let Some(ss) = self.seg_start {
            if total - self.last_voiced >= self.cfg.silence_end {
                self.seg_start = None;
                if total - ss >= SR / 2 {
                    return Some(Job::Final { start: ss, end: total, seg: ss });
                }
                return None;
            }
        }

        if let Some(ss) = self.seg_start {
            if self.cfg.partials
                && total - ss >= SR
                && total - self.last_partial >= self.cfg.partial_step
            {
                self.last_partial = total;
                let start = ss.max(total.saturating_sub(self.cfg.partial_window));
                return Some(Job::Partial { start, end: total, seg: ss });
            }
        }
        None
    }
}

pub fn rms_of(buf: &[f32]) -> f32 {
    if buf.is_empty() {
        return 0.0;
    }
    let s: f32 = buf.iter().map(|x| x * x).sum();
    (s / buf.len() as f32).sqrt()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(cfg: SegConfig, pattern: &[(bool, u64)]) -> Vec<Job> {
        let mut s = Segmenter::new(cfg, 0.002);
        let mut t = 0u64;
        let mut jobs = Vec::new();
        for &(voiced, ms) in pattern {
            let steps = ms / 100;
            for _ in 0..steps {
                t += SR / 10;
                let rms = if voiced { 0.1 } else { 0.0005 };
                if let Some(j) = s.step(rms, t) {
                    jobs.push(j);
                }
            }
        }
        jobs
    }

    #[test]
    fn legacy_emits_one_final_after_silence() {
        let jobs = run(SegConfig::legacy(), &[(false, 500), (true, 3000), (false, 1500)]);
        assert_eq!(jobs.len(), 1);
        assert!(matches!(jobs[0], Job::Final { .. }));
    }

    #[test]
    fn streaming_emits_partials_then_final() {
        let jobs = run(SegConfig::streaming(), &[(false, 500), (true, 3000), (false, 1500)]);
        let partials = jobs.iter().filter(|j| matches!(j, Job::Partial { .. })).count();
        assert!(partials >= 3, "got {:?}", jobs);
        assert!(matches!(jobs.last().unwrap(), Job::Final { .. }));
    }

    #[test]
    fn short_pause_does_not_close_segment() {
        let jobs = run(SegConfig::streaming(), &[(true, 2000), (false, 400), (true, 2000), (false, 1500)]);
        let finals = jobs.iter().filter(|j| matches!(j, Job::Final { .. })).count();
        assert_eq!(finals, 1);
    }

    #[test]
    fn partial_window_is_capped() {
        let jobs = run(SegConfig::streaming(), &[(true, 12000)]);
        for j in jobs {
            if let Job::Partial { start, end, .. } = j {
                assert!(end - start <= SegConfig::streaming().partial_window);
            }
        }
    }
}
