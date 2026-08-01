//! FDX Baseline Measurement
//!
//! Measures: process startup, file query, symbol query, grep, outline, impact,
//! git status, batching, fallback latency, cache opportunities, cold vs warm measurements.

use std::path::Path;
use std::process::Command;
use std::time::{Duration, Instant};

use crate::reader::batch;
use crate::reader::code::cache::AstCache;
use crate::reader::grep;
use crate::reader::impact::{analyze_impact, ImpactDirection};
use crate::reader::outline;
use crate::reader::search;
use crate::reader::{read_file, ReadMode, ReaderOptions};
use crate::output::OutputFormat;

/// Benchmark measurement result
#[derive(Debug, Clone)]
pub struct Measurement {
    pub name: String,
    pub cold_ms: f64,
    pub warm_ms: f64,
    pub iterations: usize,
    pub cache_hits: usize,
    pub cache_misses: usize,
}

impl Measurement {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            cold_ms: 0.0,
            warm_ms: 0.0,
            iterations: 5,
            cache_hits: 0,
            cache_misses: 0,
        }
    }

    pub fn with_iterations(mut self, n: usize) -> Self {
        self.iterations = n;
        self
    }

    pub fn speedup(&self) -> f64 {
        if self.warm_ms > 0.0 {
            self.cold_ms / self.warm_ms
        } else {
            1.0
        }
    }
}

/// Run a closure multiple times and measure elapsed time
#[allow(dead_code)]
fn measure<F, R>(mut f: F, iterations: usize) -> (R, Duration)
where
    F: FnMut() -> R,
{
    let start = Instant::now();
    for _ in 0..iterations {
        f();
    }
    let elapsed = start.elapsed();
    (f(), elapsed)
}

/// Benchmark process startup time
pub fn benchmark_startup() -> Measurement {
    let mut m = Measurement::new("process_startup");
    let start = Instant::now();
    for _ in 0..m.iterations {
        let output = Command::new("cargo")
            .args(["build", "--manifest-path", "crates/fdx/Cargo.toml"])
            .output();
        if output.is_err() {
            continue;
        }
    }
    let elapsed = start.elapsed();
    m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    m.warm_ms = m.cold_ms; // No caching for process startup
    m
}

/// Benchmark file read operation (cold vs warm with cache)
pub fn benchmark_file_read(path: &Path, mode: ReadMode) -> Measurement {
    let mut m = Measurement::new(&format!("file_read_{:?}", mode));

    let options = ReaderOptions {
        mode,
        symbol: None,
        limit: None,
        offset: 1,
        with_deps: true,
        format: OutputFormat::Text,
        no_cache: false,
    };

    // Cold run (no cache)
    {
        let cache = AstCache::new();
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = read_file(path, &options, &cache);
        }
        let elapsed = start.elapsed();
        m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    // Warm run (with cache)
    {
        let cache = AstCache::new();
        // Prime the cache first
        let _ = read_file(path, &options, &cache);
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = read_file(path, &options, &cache);
        }
        let elapsed = start.elapsed();
        m.warm_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    m
}

/// Benchmark symbol search operation
pub fn benchmark_symbol_query(pattern: &str, paths: &[PathBuf]) -> Measurement {
    let mut m = Measurement::new("symbol_query");

    // Cold run
    {
        let cache = AstCache::new();
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = search::search_symbols(pattern, paths, None, 50, true, &cache);
        }
        let elapsed = start.elapsed();
        m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    // Warm run (with cache)
    {
        let cache = AstCache::new();
        let _ = search::search_symbols(pattern, paths, None, 50, false, &cache);
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = search::search_symbols(pattern, paths, None, 50, false, &cache);
        }
        let elapsed = start.elapsed();
        m.warm_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    m
}

/// Benchmark grep operation
pub fn benchmark_grep(pattern: &str, paths: &[PathBuf]) -> Measurement {
    let mut m = Measurement::new("grep");

    let start = Instant::now();
    for _ in 0..m.iterations {
        let _ = grep::grep_files(pattern, paths, 2, false, false, 50);
    }
    let elapsed = start.elapsed();
    m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    m.warm_ms = m.cold_ms; // Grep doesn't use AST cache

    m
}

/// Benchmark outline operation
pub fn benchmark_outline(paths: &[PathBuf]) -> Measurement {
    let mut m = Measurement::new("outline");

    let options = outline::OutlineOptions {
        depth: None,
        kind_filter: None,
        min_lines: 1,
        no_cache: false,
    };

    // Cold run
    {
        let cache = AstCache::new();
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = outline::outline_paths(paths, &options, &cache);
        }
        let elapsed = start.elapsed();
        m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    // Warm run
    {
        let cache = AstCache::new();
        let _ = outline::outline_paths(paths, &options, &cache);
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = outline::outline_paths(paths, &options, &cache);
        }
        let elapsed = start.elapsed();
        m.warm_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    m
}

/// Benchmark impact analysis
pub fn benchmark_impact(files: &[PathBuf], root: &Path) -> Measurement {
    let mut m = Measurement::new("impact");

    let cache = AstCache::new();

    // Cold run
    {
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = analyze_impact(files, root, 1, ImpactDirection::Both, &cache);
        }
        let elapsed = start.elapsed();
        m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    // Warm run
    {
        let _ = analyze_impact(files, root, 1, ImpactDirection::Both, &cache);
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = analyze_impact(files, root, 1, ImpactDirection::Both, &cache);
        }
        let elapsed = start.elapsed();
        m.warm_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    m
}

/// Benchmark git status operation
pub fn benchmark_git_status() -> Measurement {
    let mut m = Measurement::new("git_status");

    let start = Instant::now();
    for _ in 0..m.iterations {
        let _ = crate::reader::git::run_git("status", &["--porcelain"]);
    }
    let elapsed = start.elapsed();
    m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    m.warm_ms = m.cold_ms;

    m
}

/// Benchmark batch read operation
pub fn benchmark_batch(patterns: &[String]) -> Measurement {
    let mut m = Measurement::new("batch");

    // Cold run
    {
        let cache = AstCache::new();
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = batch::batch_read(
                patterns,
                ReadMode::Prototype,
                None,
                None,
                OutputFormat::Text,
                true,
                20,
                &cache,
            );
        }
        let elapsed = start.elapsed();
        m.cold_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    // Warm run
    {
        let cache = AstCache::new();
        let _ = batch::batch_read(
            patterns,
            ReadMode::Prototype,
            None,
            None,
            OutputFormat::Text,
            false,
            20,
            &cache,
        );
        let start = Instant::now();
        for _ in 0..m.iterations {
            let _ = batch::batch_read(
                patterns,
                ReadMode::Prototype,
                None,
                None,
                OutputFormat::Text,
                false,
                20,
                &cache,
            );
        }
        let elapsed = start.elapsed();
        m.warm_ms = elapsed.as_secs_f64() * 1000.0 / m.iterations as f64;
    }

    m
}

/// Measure cache hit rate for a series of operations
pub fn measure_cache_hit_rate(paths: &[PathBuf]) -> (usize, usize) {
    let cache = AstCache::new();
    let options = ReaderOptions {
        mode: ReadMode::Prototype,
        symbol: None,
        limit: None,
        offset: 1,
        with_deps: true,
        format: OutputFormat::Text,
        no_cache: false,
    };

    let mut hits = 0;
    let mut misses = 0;

    for path in paths {
        let cache_before = cache.len();
        let _ = read_file(path, &options, &cache);
        let cache_after = cache.len();

        if cache_after > cache_before {
            misses += 1;
        } else {
            hits += 1;
        }
    }

    (hits, misses)
}

/// Run all benchmarks and return results
pub fn run_all_benchmarks(repo_path: &Path) -> Vec<Measurement> {
    let mut results = Vec::new();

    // Find test files
    let src_path = repo_path.join("src");
    let test_paths: Vec<PathBuf> = if src_path.exists() {
        collect_rust_files(&src_path)
    } else {
        vec![repo_path.to_path_buf()]
    };

    let patterns = test_paths
        .iter()
        .take(10)
        .map(|p| p.to_string_lossy().to_string())
        .collect::<Vec<_>>();

    if !patterns.is_empty() {
        results.push(benchmark_batch(&patterns));
    }

    if let Some(first_file) = test_paths.first() {
        results.push(benchmark_file_read(first_file, ReadMode::Prototype));
        results.push(benchmark_file_read(first_file, ReadMode::Deep));
    }

    if test_paths.len() >= 2 {
        results.push(benchmark_symbol_query("fn", &test_paths));
    }

    if !test_paths.is_empty() {
        results.push(benchmark_outline(&test_paths));
        results.push(benchmark_impact(&test_paths, repo_path));
    }

    results.push(benchmark_git_status());

    results
}

fn collect_rust_files(dir: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                files.extend(collect_rust_files(&path));
            } else if path.extension().map_or(false, |e| e == "rs") {
                files.push(path);
            }
        }
    }
    files
}

/// Print benchmark results in a formatted table
pub fn print_results(results: &[Measurement]) {
    println!("\n{:30} {:>12} {:>12} {:>10}", "Benchmark", "Cold (ms)", "Warm (ms)", "Speedup");
    println!("{}", "-".repeat(70));
    for m in results {
        println!(
            "{:30} {:>12.2} {:>12.2} {:>10.2}x",
            m.name, m.cold_ms, m.warm_ms, m.speedup()
        );
    }
}

use std::path::PathBuf;
