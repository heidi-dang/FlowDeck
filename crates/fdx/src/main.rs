use clap::{Parser, Subcommand};
use std::path::PathBuf;
use std::process;

use fdx::output::{json, text, OutputFormat};
use fdx::reader::batch;
use fdx::reader::code::cache::AstCache;
use fdx::reader::grep;
use fdx::reader::impact::{self, ImpactDirection};
use fdx::reader::search;
use fdx::reader::{read_file, ReadMode, ReaderOptions};

#[derive(Parser)]
#[command(name = "fdx")]
#[command(version = "0.1.0")]
#[command(about = "FlowDeck token-optimized file reader")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
pub enum HistoryAction {
    /// List historical verification runs
    Runs {
        /// Maximum number of runs to return (default: 50)
        #[arg(long, default_value = "50")]
        limit: usize,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Show details for a specific historical verification run
    Show {
        /// Run identifier
        run_id: String,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Show historical statistics and flake signal for a check ID
    Stats {
        /// Check identifier
        check_id: String,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Show changed entities that co-occurred with a check ID
    Cooccurrences {
        /// Check identifier
        check_id: String,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Reconcile .fdx/runs/*.json artifacts into SQLite history
    Reconcile {
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
}

#[derive(Subcommand)]
pub enum AttestAction {
    /// Create a deterministic verification attestation for a qualified verification run
    Create {
        /// Verification run identifier
        #[arg(long)]
        run: String,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Verify an in-toto attestation against source run artifact and M8 runtime history
    Verify {
        /// Path to attestation JSON file
        file: PathBuf,
        /// Expected SHA-256 digest of attestation (required for non-content-addressed external files)
        #[arg(long)]
        expected_sha256: Option<String>,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// Inspect an in-toto attestation file
    Show {
        /// Path to attestation JSON file
        file: PathBuf,
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
    /// List all attestations in .fdx/attestations/
    List {
        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },
}

#[derive(Subcommand)]
pub enum BuildAction {
    /// Show build provider status / freshness / topology stats
    Status,
    /// Refresh build providers (bounded, read-only discovery)
    Refresh,
    /// Output build graph in JSON format
    Graph {
        #[arg(long, default_value = "json")]
        format: String,
    },
}

#[derive(Subcommand)]
pub enum SemanticAction {
    /// Show provider health/freshness/fingerprint/scope/last run/reason
    Status,
    /// Refresh semantic providers (bounded, no downloads)
    Refresh {
        /// Refresh only this provider id
        #[arg(long)]
        provider: Option<String>,
    },
    /// Decode an SCIP index file and report bounded statistics
    Decode {
        /// Path to the .scip file
        file: PathBuf,
    },
    /// Reference query with explicit provenance and completeness
    References {
        /// Symbol name or SCIP canonical symbol
        symbol: String,
        /// Language: rust, typescript, javascript
        #[arg(long, default_value = "rust")]
        lang: String,
        /// Intent: localize, reference_complete, rename, impact_seed, context
        #[arg(long, default_value = "reference_complete")]
        intent: String,
    },
}

#[derive(Subcommand)]
enum Commands {
    /// Native EvidenceGraph index management
    ///
    /// Example: fdx index status
    Index {
        /// Action: "status", or none to run index
        action: Option<String>,

        /// Force refresh existing files
        #[arg(long)]
        refresh: bool,
    },
    /// Semantic provider diagnostics and refresh (SCIP evidence)
    ///
    /// Example: fdx semantic status
    Semantic {
        #[command(subcommand)]
        action: SemanticAction,
    },
    /// Build/config provider diagnostics, refresh, and graph query (Milestone 5)
    ///
    /// Example: fdx build status
    Build {
        #[command(subcommand)]
        action: BuildAction,
    },
    /// Read a file with token-optimized output
    ///
    /// Example: fdx read src/main.rs --mode prototype
    Read {
        /// Path to the file to read
        file: PathBuf,

        /// Read mode: auto, raw, prototype, deep
        #[arg(long, default_value = "auto")]
        mode: String,

        /// Target symbol for deep mode
        #[arg(long)]
        symbol: Option<String>,

        /// Max lines to return (text mode only)
        #[arg(long)]
        limit: Option<usize>,

        /// Start line, 1-indexed (text mode only)
        #[arg(long, default_value = "1")]
        offset: usize,

        /// Pull related symbols in deep mode
        #[arg(long, default_value = "true", action = clap::ArgAction::Set)]
        with_deps: bool,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Bypass session AST cache
        #[arg(long)]
        no_cache: bool,
    },

    /// Search for symbols by name across files or directories
    ///
    /// Example: fdx search calculate_fee src/
    Search {
        /// Pattern to search for (case-insensitive substring match)
        pattern: String,

        /// Explicit path to search
        #[arg(long)]
        path: Option<PathBuf>,

        /// Positional paths to search (files or directories)
        paths: Vec<PathBuf>,

        /// Filter by symbol kind: function, class, struct, trait, interface, enum, any
        #[arg(long, default_value = "any")]
        kind: String,

        /// Hard cap on total matches returned
        #[arg(long, default_value = "50")]
        max_matches: usize,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Bypass session AST cache
        #[arg(long)]
        no_cache: bool,
    },

    /// Token-optimized grep with regex search
    ///
    /// Example: fdx grep "fn calculate" src/ --context 2
    Grep {
        /// Pattern to search for
        pattern: String,

        /// Explicit path to search
        #[arg(long)]
        path: Option<PathBuf>,

        /// Positional paths to search (files or directories)
        paths: Vec<PathBuf>,

        /// Lines of context around each match
        #[arg(long, default_value = "2")]
        context: usize,

        /// Treat pattern as literal string, not regex
        #[arg(long)]
        fixed_strings: bool,

        /// Case-sensitive search
        #[arg(long)]
        case_sensitive: bool,

        /// Hard cap on total matches returned
        #[arg(long, default_value = "50")]
        max_matches: usize,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Bypass session AST cache
        #[arg(long)]
        no_cache: bool,
    },

    /// Read multiple files in one call
    ///
    /// Example: fdx batch "src/*.rs" --mode prototype
    Batch {
        /// Files or glob patterns to read
        patterns: Vec<String>,

        /// Read mode: prototype, deep, raw
        #[arg(long, default_value = "prototype")]
        mode: String,

        /// Target symbol for deep mode
        #[arg(long)]
        symbol: Option<String>,

        /// Limit lines per file
        #[arg(long)]
        limit_per_file: Option<usize>,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Bypass session AST cache
        #[arg(long)]
        no_cache: bool,

        /// Hard cap on number of files
        #[arg(long, default_value = "20")]
        max_files: usize,
    },

    /// Lightweight cross-file dependency analysis

    ///
    /// Example: fdx impact src/payment/fee.rs --direction both
    Impact {
        /// Target files to analyze
        files: Vec<PathBuf>,

        /// How many hops to follow
        #[arg(long, default_value = "1")]
        depth: usize,

        /// Direction: in, out, both
        #[arg(long, default_value = "both")]
        direction: String,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Project root for resolving imports
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },

    /// Token-optimized directory listing
    ///
    /// Example: fdx ls src/ --all
    Ls {
        /// Path to list (default: current directory)
        path: Option<PathBuf>,

        /// Include hidden files
        #[arg(short, long)]
        all: bool,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },

    /// Compact directory tree, gitignore-aware
    ///
    /// Example: fdx tree src/ --depth 2
    Tree {
        /// Path to tree (default: current directory)
        path: Option<PathBuf>,

        /// Max depth (default: 3)
        #[arg(long, default_value = "3")]
        depth: usize,

        /// Show directories only
        #[arg(long)]
        dirs_only: bool,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },

    /// Token-optimized git subcommands
    ///
    /// Example: fdx git status
    Git {
        /// Git subcommand and arguments
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },

    /// Failures-only test runner wrapper
    ///
    /// Example: fdx test cargo
    Test {
        /// Test runner: cargo, pytest, jest, vitest, go, rspec, rails
        runner: String,

        /// Additional arguments for the test runner
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },

    /// Failures-only lint wrapper
    ///
    /// Example: fdx lint clippy
    Lint {
        /// Linter: ruff, clippy, tsc, eslint, biome, golangci, rubocop
        linter: String,

        /// Additional arguments for the linter
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },

    /// Project-wide symbol outline
    ///
    /// Example: fdx outline src/ --depth 2 --kind function,struct
    Outline {
        /// Paths to outline (files or directories)
        paths: Vec<PathBuf>,

        /// Directory traversal depth (default: unlimited)
        #[arg(long)]
        depth: Option<usize>,

        /// Comma-separated kind filter: function,class,struct,trait,interface,enum,method,type
        #[arg(long)]
        kind: Option<String>,

        /// Only include symbols with body >= N lines
        #[arg(long, default_value = "1")]
        min_lines: usize,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Bypass session AST cache
        #[arg(long)]
        no_cache: bool,
    },

    /// Symbol-aware git diff
    ///
    /// Example: fdx diff HEAD~1 --format json
    Diff {
        /// Git ref to diff against (default: HEAD~1)
        commit: Option<String>,

        /// Paths to limit diff to
        #[arg(last = true)]
        paths: Vec<PathBuf>,

        /// Diff staged changes (index vs HEAD)
        #[arg(long)]
        staged: bool,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,

        /// Bypass session AST cache
        #[arg(long)]
        no_cache: bool,

        /// Git repository root
        #[arg(long, default_value = ".")]
        root: PathBuf,
    },

    /// Per-topic agent-output log: append, read, or clear
    ///
    /// Example: fdx context --topic mytopic --action append --agent coder --stage impl --summary "..."
    Context {
        /// Action: append, read, or clear
        #[arg(long, default_value = "read")]
        action: String,

        /// Topic slug (will be re-slugified by Rust's canonical slugify_topic)
        #[arg(long)]
        topic: String,

        /// Agent name (required for action=append)
        #[arg(long)]
        agent: Option<String>,

        /// Stage name (required for action=append)
        #[arg(long)]
        stage: Option<String>,

        /// Summary text (required for action=append)
        #[arg(long)]
        summary: Option<String>,
    },

    /// Per-topic design-decision log: record or read
    ///
    /// Example: fdx decisions --topic mytopic --action record --decision "..." --rationale "..."
    Decisions {
        /// Action: record or read
        #[arg(long, default_value = "read")]
        action: String,

        /// Topic slug (will be re-slugified by Rust's canonical slugify_topic)
        #[arg(long)]
        topic: String,

        /// Decision text (required for action=record)
        #[arg(long)]
        decision: Option<String>,

        /// Rationale text (required for action=record)
        #[arg(long)]
        rationale: Option<String>,

        /// Who made the decision (defaults to "orchestrator")
        #[arg(long)]
        made_by: Option<String>,
    },

    /// Verifiable transitive impact analysis (Milestone 4)
    ///
    /// Example: fdx impact-v2 --base HEAD~1 --depth 3
    #[command(name = "impact-v2")]
    ImpactV2 {
        /// Base Git ref (e.g. HEAD, HEAD~1, main)
        #[arg(long)]
        base: Option<String>,

        /// Head Git ref (defaults to working tree)
        #[arg(long)]
        head: Option<String>,

        /// Maximum traversal depth (default: 3)
        #[arg(long, default_value = "3")]
        depth: usize,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },

    /// Explain why a target is impacted by semantic changes
    ///
    /// Example: fdx why src/api.ts --base HEAD~1
    Why {
        /// Target file or symbol path to explain
        target: String,

        /// Base Git ref (e.g. HEAD, HEAD~1, main)
        #[arg(long)]
        base: Option<String>,

        /// Head Git ref (defaults to working tree)
        #[arg(long)]
        head: Option<String>,

        /// Maximum traversal depth (default: 3)
        #[arg(long, default_value = "3")]
        depth: usize,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },

    /// Deterministic test and verification check planner (Milestone 6)
    ///
    /// Example: fdx plan --base HEAD~1 --format json
    Plan {
        /// Base Git ref (e.g. HEAD, HEAD~1, main)
        #[arg(long)]
        base: Option<String>,

        /// Head Git ref (defaults to working tree)
        #[arg(long)]
        head: Option<String>,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },

    /// Bounded verification plan execution (Milestone 7)
    ///
    /// Example: fdx verify --base HEAD~1 --format json
    Verify {
        /// Base Git ref (e.g. HEAD, HEAD~1, main)
        #[arg(long)]
        base: Option<String>,

        /// Head Git ref (defaults to working tree)
        #[arg(long)]
        head: Option<String>,

        /// Stop execution immediately upon the first failure
        #[arg(long)]
        fail_fast: bool,

        /// Do not persist execution run artifact to .fdx/runs/
        #[arg(long)]
        no_persist: bool,

        /// Output format: text or json
        #[arg(long, default_value = "text")]
        format: String,
    },

    /// Historical verification run observations and statistics (Milestone 8)
    ///
    /// Example: fdx history runs --limit 20
    History {
        #[command(subcommand)]
        action: HistoryAction,
    },

    /// Verification attestation and cryptographic evidence binding (Milestone 9)
    ///
    /// Example: fdx attest create --run run-123
    Attest {
        #[command(subcommand)]
        action: AttestAction,
    },
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("fdx {}", env!("CARGO_PKG_VERSION"));
        return;
    }

    // Resident daemon mode: `fdx serve [--root <dir>]` runs the persistent JSON-lines IPC loop
    // over stdin/stdout (one long-lived process serving many requests).
    if args.iter().any(|a| a == "serve") {
        let mut root_path = None;
        let mut iter = args.iter().skip(1);
        while let Some(arg) = iter.next() {
            if arg == "--root" {
                if let Some(val) = iter.next() {
                    root_path = Some(PathBuf::from(val));
                }
            } else if let Some(stripped) = arg.strip_prefix("--root=") {
                root_path = Some(PathBuf::from(stripped));
            }
        }
        fdx::serve::run(root_path);
        return;
    }

    let cli = Cli::parse();

    match cli.command {
        Commands::Read {
            file,
            mode,
            symbol,
            limit,
            offset,
            with_deps,
            format,
            no_cache,
        } => {
            let mode = parse_mode(&mode);
            let format = parse_format(&format);

            let options = ReaderOptions {
                mode,
                symbol,
                limit,
                offset,
                with_deps,
                format,
                no_cache,
            };

            let cache = AstCache::new();

            match read_file(&file, &options, &cache) {
                Ok(result) => {
                    let mut stdout = std::io::stdout();
                    match result {
                        fdx::reader::ReadResult::Code(code_result) => match options.format {
                            OutputFormat::Text => {
                                if let Err(e) = text::print_text_output(
                                    &mut stdout,
                                    &code_result.path,
                                    &code_result.language,
                                    &code_result.mode,
                                    code_result.total_lines,
                                    &code_result.symbols,
                                    code_result.parse_error.as_deref(),
                                ) {
                                    eprintln!("Output error: {}", e);
                                    process::exit(1);
                                }
                                if code_result.mode == "deep" {
                                    if let Err(e) = text::print_dependencies(
                                        &mut stdout,
                                        &code_result.dependencies,
                                    ) {
                                        eprintln!("Output error: {}", e);
                                        process::exit(1);
                                    }
                                }
                            }
                            OutputFormat::Json => {
                                if let Err(e) = json::print_json_output(&mut stdout, &code_result) {
                                    eprintln!("Output error: {}", e);
                                    process::exit(1);
                                }
                            }
                        },
                        fdx::reader::ReadResult::Text(text_result) => match options.format {
                            OutputFormat::Text => {
                                if let Err(e) = text::print_text_result(
                                    &mut stdout,
                                    &text_result.path,
                                    &text_result,
                                ) {
                                    eprintln!("Output error: {}", e);
                                    process::exit(1);
                                }
                            }
                            OutputFormat::Json => {
                                if let Err(e) =
                                    json::print_json_text_result(&mut stdout, &text_result)
                                {
                                    eprintln!("Output error: {}", e);
                                    process::exit(1);
                                }
                            }
                        },
                    }
                }
                Err(e) => {
                    eprintln!("Error reading file: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Search {
            pattern,
            path,
            paths,
            kind,
            max_matches,
            format,
            no_cache,
        } => {
            let mut search_paths = paths;
            if let Some(p) = path {
                search_paths.push(p);
            }
            if search_paths.is_empty() {
                search_paths.push(PathBuf::from("."));
            }

            let format = parse_format(&format);
            let kind_filter = if kind == "any" {
                None
            } else {
                Some(kind.as_str())
            };

            let cache = AstCache::new();

            match search::search_symbols(
                &pattern,
                &search_paths,
                kind_filter,
                max_matches,
                no_cache,
                &cache,
            ) {
                Ok(matches) => {
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) =
                                text::print_search_results(&mut stdout, &matches, &pattern)
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) =
                                json::print_json_search_results(&mut stdout, &matches, &pattern)
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error searching: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Grep {
            pattern,
            path,
            paths,
            context,
            fixed_strings,
            case_sensitive,
            max_matches,
            format,
            no_cache: _,
        } => {
            let mut search_paths = paths;
            if let Some(p) = path {
                search_paths.push(p);
            }
            if search_paths.is_empty() {
                search_paths.push(PathBuf::from("."));
            }

            let format = parse_format(&format);

            let context = context.min(fdx::reader::grep::ABSOLUTE_MAX_CONTEXT);
            let max_matches = max_matches.min(fdx::reader::grep::ABSOLUTE_MAX_MATCHES);

            match grep::grep_files(
                &pattern,
                &search_paths,
                context,
                fixed_strings,
                case_sensitive,
                max_matches,
            ) {
                Ok((files, total_matches, truncated)) => {
                    let tee_path = if truncated {
                        let full_output = build_full_grep_output(&files, total_matches);
                        fdx::tee::save_tee("grep", &full_output).ok()
                    } else {
                        None
                    };
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) = text::print_grep_results(
                                &mut stdout,
                                &files,
                                total_matches,
                                truncated,
                                tee_path.as_deref(),
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) = json::print_json_grep_results(
                                &mut stdout,
                                &files,
                                total_matches,
                                truncated,
                                tee_path.as_deref(),
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error grepping: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Batch {
            patterns,
            mode,
            symbol,
            limit_per_file,
            format,
            no_cache,
            max_files,
        } => {
            if patterns.is_empty() {
                eprintln!("Error: at least one pattern is required");
                process::exit(1);
            }

            let mode = parse_mode(&mode);
            let format = parse_format(&format);
            let cache = AstCache::new();

            match batch::batch_read(
                &patterns,
                mode,
                symbol.as_deref(),
                limit_per_file,
                format.clone(),
                no_cache,
                max_files,
                &cache,
            ) {
                Ok((items, _count, truncated)) => {
                    let mut stdout = std::io::stdout();

                    match format {
                        OutputFormat::Text => {
                            if let Err(e) =
                                text::print_batch_results(&mut stdout, &items, truncated)
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) =
                                json::print_json_batch_results(&mut stdout, &items, truncated)
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error batch reading: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Impact {
            files,
            depth,
            direction,
            format,
            root,
        } => {
            if files.is_empty() {
                eprintln!("Error: at least one file is required");
                process::exit(1);
            }

            let format = parse_format(&format);
            let direction = match direction.parse::<ImpactDirection>() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("Error: {}", e);
                    process::exit(1);
                }
            };

            let cache = AstCache::new();

            match impact::analyze_impact(&files, &root, depth, direction, &cache) {
                Ok(results) => {
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) = text::print_impact_results(&mut stdout, &results) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) = json::print_json_impact_results(&mut stdout, &results) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error analyzing impact: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Ls { path, all, format } => {
            let format = parse_format(&format);
            let path = path.unwrap_or_else(|| PathBuf::from("."));

            let options = fdx::reader::ls::LsOptions {
                all,
                format: format.clone(),
            };

            match fdx::reader::ls::ls_paths(&path, &options) {
                Ok(result) => {
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) =
                                fdx::output::ls_tree_text::print_ls_results(&mut stdout, &result)
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) = fdx::output::ls_tree_json::print_json_ls_results(
                                &mut stdout,
                                &result,
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error listing directory: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Tree {
            path,
            depth,
            dirs_only,
            format,
        } => {
            let format = parse_format(&format);
            let path = path.unwrap_or_else(|| PathBuf::from("."));

            let options = fdx::reader::tree::TreeOptions { depth, dirs_only };

            match fdx::reader::tree::tree_paths(&path, &options) {
                Ok(result) => {
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) =
                                fdx::output::ls_tree_text::print_tree_results(&mut stdout, &result)
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) = fdx::output::ls_tree_json::print_json_tree_results(
                                &mut stdout,
                                &result,
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error generating tree: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Git { args } => {
            if args.is_empty() {
                eprintln!("Error: git subcommand required");
                process::exit(1);
            }

            let subcommand = &args[0];
            let extra_args: Vec<&str> = args.iter().skip(1).map(|s| s.as_str()).collect();

            match fdx::reader::git::run_git(subcommand, &extra_args) {
                Ok(output) => {
                    print!("{}", output.stdout);
                    if !output.stderr.is_empty() {
                        eprint!("{}", output.stderr);
                    }
                    if !output.success {
                        process::exit(output.exit_code);
                    }
                }
                Err(e) => {
                    eprintln!("{}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Test { runner, args } => {
            match fdx::reader::test_runner::run_tests(&runner, &args) {
                Ok(output) => {
                    print!("{}", output.stdout);
                    if !output.stderr.is_empty() {
                        eprint!("{}", output.stderr);
                    }
                    if !output.success {
                        process::exit(output.exit_code);
                    }
                }
                Err(e) => {
                    eprintln!("{}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Lint { linter, args } => match fdx::reader::lint::run_linter(&linter, &args) {
            Ok(output) => {
                print!("{}", output.stdout);
                if !output.stderr.is_empty() {
                    eprint!("{}", output.stderr);
                }
                if !output.success {
                    process::exit(output.exit_code);
                }
            }
            Err(e) => {
                eprintln!("{}", e);
                process::exit(1);
            }
        },

        Commands::Outline {
            paths,
            depth,
            kind,
            min_lines,
            format,
            no_cache,
        } => {
            if paths.is_empty() {
                eprintln!("Error: at least one path is required");
                process::exit(1);
            }

            let format = parse_format(&format);

            let kind_filter = kind.as_ref().map(|k| {
                k.split(',')
                    .map(|s| s.trim().to_lowercase())
                    .collect::<Vec<_>>()
            });

            let options = fdx::reader::outline::OutlineOptions {
                depth,
                kind_filter,
                min_lines,
                no_cache,
            };

            let cache = AstCache::new();

            match fdx::reader::outline::outline_paths(&paths, &options, &cache) {
                Ok(results) => {
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) = fdx::output::outline_diff_text::print_outline_results(
                                &mut stdout,
                                &results,
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) =
                                fdx::output::outline_diff_json::print_json_outline_results(
                                    &mut stdout,
                                    &results,
                                )
                            {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("Error generating outline: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Diff {
            commit,
            paths,
            staged,
            format,
            no_cache,
            root,
        } => {
            let format = parse_format(&format);
            let commit_str = commit.unwrap_or_else(|| "HEAD~1".to_string());

            let options = fdx::reader::diff::DiffOptions {
                commit: commit_str.clone(),
                staged,
                paths,
                no_cache,
                root,
            };

            let cache = AstCache::new();

            match fdx::reader::diff::diff_against(&options, &cache) {
                Ok(results) => {
                    let mut stdout = std::io::stdout();
                    match format {
                        OutputFormat::Text => {
                            if let Err(e) = fdx::output::outline_diff_text::print_diff_results(
                                &mut stdout,
                                &results,
                                &commit_str,
                                staged,
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                        OutputFormat::Json => {
                            if let Err(e) = fdx::output::outline_diff_json::print_json_diff_results(
                                &mut stdout,
                                &results,
                                &commit_str,
                                staged,
                            ) {
                                eprintln!("Output error: {}", e);
                                process::exit(1);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("{}", e);
                    process::exit(1);
                }
            }
        }
        Commands::Context {
            action,
            topic,
            agent,
            stage,
            summary,
        } => {
            let home = match std::env::var_os("HOME") {
                Some(s) => std::path::PathBuf::from(s),
                None => {
                    eprintln!("Error: HOME environment variable not set");
                    process::exit(1);
                }
            };
            let cwd_path = std::path::Path::new(".");
            let repo_root = fdx::paths::find_repository_root(cwd_path)
                .unwrap_or_else(|_| cwd_path.to_path_buf());
            let cwd = repo_root.as_path();
            let legacy_name = cwd
                .canonicalize()
                .ok()
                .and_then(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
                .unwrap_or_default();
            let project_slug = fdx::paths::project_slug_from_directory(cwd);
            if !legacy_name.is_empty() {
                if let Err(e) =
                    fdx::paths::migrate_legacy_planning_dir(&home, &project_slug, &legacy_name)
                {
                    eprintln!("Error: Legacy planning migration failed: {}", e);
                    process::exit(1);
                }
            }
            let result = match action.as_str() {
                "append" => fdx::commands::context::append(
                    &home,
                    &project_slug,
                    &topic,
                    agent.as_deref().unwrap_or(""),
                    stage.as_deref().unwrap_or(""),
                    summary.as_deref().unwrap_or(""),
                ),
                "read" => fdx::commands::context::read(&home, &project_slug, &topic),
                "clear" => fdx::commands::context::clear(&home, &project_slug, &topic),
                other => Err(format!("Error: unknown action {}", other)),
            };
            match result {
                Ok(s) => println!("{}", s),
                Err(e) => {
                    eprintln!("{}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Index { action, refresh } => {
            let cwd_path = std::path::Path::new(".");
            let repo_root = fdx::paths::find_repository_root(cwd_path)
                .unwrap_or_else(|_| cwd_path.to_path_buf());
            let repo_root_ref = repo_root.as_path();

            let action_str = action.as_deref().unwrap_or("run");
            let open_mode = if refresh || action_str == "run" {
                fdx::intelligence::db::DatabaseOpenMode::ReadWrite
            } else {
                fdx::intelligence::db::DatabaseOpenMode::ReadOnly
            };

            let db_result = fdx::intelligence::db::EvidenceDatabase::open(repo_root_ref, open_mode);

            if action_str == "run" && db_result.is_err() {
                eprintln!("Error: {}", db_result.err().unwrap());
                process::exit(1);
            }

            match action_str {
                "status" => {
                    let db_ref = match &db_result {
                        Ok(db) => Ok(db),
                        Err(e) => Err(e),
                    };
                    let report = fdx::intelligence::status::evaluate_index_status(
                        repo_root_ref,
                        db_ref,
                        &fdx::protocol::GraphCompatibility::default(),
                    );
                    println!("INDEX {}", report.state);
                    if !report.reasons.is_empty() {
                        println!("reason={}", report.reasons.join(","));
                    }
                    println!("schema={}", report.schema_version);
                    println!("generation={}", report.generation);
                    println!("files={}", report.files);
                    println!("nodes={}", report.nodes);
                    println!("edges={}", report.edges);
                    println!("journal={}", report.journal_mode);
                    println!("foreign_keys={}", report.foreign_keys);
                    println!("busy_timeout={}", report.busy_timeout);
                }
                "run" => {
                    match fdx::intelligence::engine::run_incremental_index(repo_root_ref, refresh) {
                        Ok(report) => {
                            println!("INDEX {}", report.state.to_string());
                            if !report.reasons.is_empty() {
                                println!("reason={}", report.reasons.join(","));
                            }
                            if report.skipped > 0 {
                                println!("skipped={}", report.skipped);
                            }
                            println!("files={}", report.files);
                            println!("changed={}", report.changed);
                            println!("generation={}", report.generation);
                        }
                        Err(e) => {
                            eprintln!("INDEX failed");
                            eprintln!("Error: {}", e);
                            process::exit(1);
                        }
                    }
                }
                other => {
                    eprintln!("Unknown index action: {}", other);
                    process::exit(1);
                }
            }
        }
        Commands::Build { action } => {
            let cwd_path = std::path::Path::new(".");
            let repo_root = fdx::paths::find_repository_root(cwd_path)
                .unwrap_or_else(|_| cwd_path.to_path_buf());
            match action {
                BuildAction::Status => match fdx::cmd_build::build_status(&repo_root) {
                    Ok(s) => print!("{}", s),
                    Err(e) => {
                        eprintln!("Error: {}", e);
                        process::exit(1);
                    }
                },
                BuildAction::Refresh => match fdx::cmd_build::build_refresh(&repo_root) {
                    Ok((out, failed)) => {
                        print!("{}", out);
                        if failed {
                            process::exit(1);
                        }
                    }
                    Err(e) => {
                        eprintln!("Error: {}", e);
                        process::exit(1);
                    }
                },
                BuildAction::Graph { format: _ } => {
                    match fdx::cmd_build::build_graph_json(&repo_root) {
                        Ok(s) => println!("{}", s),
                        Err(e) => {
                            eprintln!("Error: {}", e);
                            process::exit(1);
                        }
                    }
                }
            }
        }

        Commands::Semantic { action } => {
            use fdx::intelligence::semantic::router::IntelligenceIntent;
            use fdx::intelligence::semantic::LanguageId;
            let cwd_path = std::path::Path::new(".");
            let repo_root = fdx::paths::find_repository_root(cwd_path)
                .unwrap_or_else(|_| cwd_path.to_path_buf());
            match action {
                SemanticAction::Status => match fdx::cmd_semantic::semantic_status(&repo_root) {
                    Ok(s) => print!("{}", s),
                    Err(e) => {
                        eprintln!("Error: {}", e);
                        process::exit(1);
                    }
                },
                SemanticAction::Refresh { provider } => {
                    match fdx::cmd_semantic::semantic_refresh(&repo_root, provider.as_deref()) {
                        Ok((out, failed)) => {
                            print!("{}", out);
                            if failed {
                                process::exit(1);
                            }
                        }
                        Err(e) => {
                            eprintln!("Error: {}", e);
                            process::exit(1);
                        }
                    }
                }
                SemanticAction::Decode { file } => {
                    match fdx::cmd_semantic::semantic_decode(&repo_root, &file) {
                        Ok(s) => print!("{}", s),
                        Err(e) => {
                            eprintln!("Error: {}", e);
                            process::exit(1);
                        }
                    }
                }
                SemanticAction::References {
                    symbol,
                    lang,
                    intent,
                } => {
                    let language = match LanguageId::from_str_opt(&lang) {
                        Some(l) => l,
                        None => {
                            eprintln!("Error: unsupported language: {}", lang);
                            process::exit(1);
                        }
                    };
                    let intent_parsed = IntelligenceIntent::parse(&intent)
                        .unwrap_or(IntelligenceIntent::ReferenceComplete);
                    match fdx::cmd_semantic::semantic_references(
                        &repo_root,
                        language,
                        &symbol,
                        intent_parsed,
                    ) {
                        Ok(s) => print!("{}", s),
                        Err(e) => {
                            eprintln!("Error: {}", e);
                            process::exit(1);
                        }
                    }
                }
            }
        }
        Commands::Decisions {
            action,
            topic,
            decision,
            rationale,
            made_by,
        } => {
            let home = match std::env::var_os("HOME") {
                Some(s) => std::path::PathBuf::from(s),
                None => {
                    eprintln!("Error: HOME environment variable not set");
                    process::exit(1);
                }
            };
            let cwd = std::path::Path::new(".");
            let legacy_name = cwd
                .canonicalize()
                .ok()
                .and_then(|p| p.file_name().and_then(|n| n.to_str()).map(String::from))
                .unwrap_or_default();
            let project_slug = fdx::paths::project_slug_from_directory(cwd);
            if !legacy_name.is_empty() {
                if let Err(e) =
                    fdx::paths::migrate_legacy_planning_dir(&home, &project_slug, &legacy_name)
                {
                    eprintln!("Error: Legacy planning migration failed: {}", e);
                    process::exit(1);
                }
            }

            let result = match action.as_str() {
                "record" => fdx::commands::decisions::record(
                    &home,
                    &project_slug,
                    &topic,
                    decision.as_deref().unwrap_or(""),
                    rationale.as_deref().unwrap_or(""),
                    made_by.as_deref(),
                ),
                "read" => fdx::commands::decisions::read(&home, &project_slug, &topic),
                other => Err(format!("Error: unknown action {}", other)),
            };
            match result {
                Ok(s) => println!("{}", s),
                Err(e) => {
                    eprintln!("{}", e);
                    process::exit(1);
                }
            }
        }

        Commands::ImpactV2 {
            base,
            head,
            depth,
            format,
        } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let repo_root = fdx::paths::find_repository_root(&cwd).unwrap_or(cwd);
            let format = parse_format(&format);

            match fdx::intelligence::change::analyze_impact_v2(
                &repo_root,
                base.as_deref(),
                head.as_deref(),
                Some(depth),
            ) {
                Ok(result) => match format {
                    OutputFormat::Json => {
                        if let Ok(json_str) = serde_json::to_string_pretty(&result) {
                            println!("{}", json_str);
                        }
                    }
                    OutputFormat::Text => {
                        println!("Assurance: {:?}", result.assurance);
                        println!("Changes ({}):", result.changes.len());
                        for c in &result.changes {
                            if let Some(ref sym) = c.symbol {
                                println!("  - [{:?}] {}::{}", c.change_kind, c.file, sym);
                            } else {
                                println!("  - [{:?}] {}", c.change_kind, c.file);
                            }
                        }
                        println!("Impacted Targets ({}):", result.impacted.len());
                        for t in &result.impacted {
                            let strength_str = format!("{:?}", t.strength).to_lowercase();
                            if let Some(ref p) = t.primary_path {
                                println!("  - [{}] (depth {}) {}", strength_str, t.depth, t.target);
                                println!("    Reason: {}", p.explanation);
                            } else if let Some(ref w) = t.widening_reason {
                                println!("  - [{}] (depth {}) {}", strength_str, t.depth, t.target);
                                println!("    Widening: {}", w);
                            } else {
                                println!("  - [{}] (depth {}) {}", strength_str, t.depth, t.target);
                            }
                        }
                        if !result.uncertainty.is_empty() {
                            println!("Uncertainties ({}):", result.uncertainty.len());
                            for u in &result.uncertainty {
                                println!("  - [{}] {:?}", u.code(), u);
                            }
                        }
                    }
                },
                Err(e) => {
                    eprintln!("Error in impact analysis: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Why {
            target,
            base,
            head,
            depth,
            format,
        } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let repo_root = fdx::paths::find_repository_root(&cwd).unwrap_or(cwd);
            let format = parse_format(&format);

            match fdx::intelligence::change::explain_why_target(
                &repo_root,
                &target,
                base.as_deref(),
                head.as_deref(),
                Some(depth),
            ) {
                Ok(Some(target_info)) => match format {
                    OutputFormat::Json => {
                        if let Ok(json_str) = serde_json::to_string_pretty(&target_info) {
                            println!("{}", json_str);
                        }
                    }
                    OutputFormat::Text => {
                        println!("Target: {}", target_info.target);
                        println!("Kind: {:?}", target_info.target_kind);
                        println!("Depth: {}", target_info.depth);
                        println!("Strength: {:?}", target_info.strength);
                        if let Some(ref p) = target_info.primary_path {
                            println!(
                                "Primary Explanation:
  {}",
                                p.explanation
                            );
                            if !p.steps.is_empty() {
                                println!("Evidence Steps:");
                                for (i, s) in p.steps.iter().enumerate() {
                                    println!(
                                        "  {}. {} -> {:?} -> {} (provider: {}, strength: {:?})",
                                        i + 1,
                                        s.from_node,
                                        s.edge_kind,
                                        s.to_node,
                                        s.provider,
                                        s.strength
                                    );
                                }
                            }
                        }
                        if !target_info.alternate_paths.is_empty() {
                            println!(
                                "Alternate Paths ({} of {} total):",
                                target_info.alternate_paths.len(),
                                target_info.alternate_path_count
                            );
                            for (i, p) in target_info.alternate_paths.iter().enumerate() {
                                println!("  Alt {}: {}", i + 1, p.explanation);
                            }
                        }
                        if let Some(ref w) = target_info.widening_reason {
                            println!("Widening Reason: {}", w);
                        }
                    }
                },
                Ok(None) => match format {
                    OutputFormat::Json => {
                        println!("null");
                    }
                    OutputFormat::Text => {
                        println!("Target '{}' is not impacted by detected changes.", target);
                    }
                },
                Err(e) => {
                    eprintln!("Error explaining target: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Plan { base, head, format } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let repo_root = fdx::paths::find_repository_root(&cwd).unwrap_or(cwd);
            let format = parse_format(&format);

            match fdx::intelligence::testplan::planner::plan_verification(
                &repo_root,
                base.as_deref(),
                head.as_deref(),
                None,
            ) {
                Ok(plan) => match format {
                    OutputFormat::Json => {
                        if let Ok(json_str) = serde_json::to_string_pretty(&plan) {
                            println!("{}", json_str);
                        }
                    }
                    OutputFormat::Text => {
                        let text =
                            fdx::intelligence::testplan::explain::format_verification_plan_text(
                                &plan,
                            );
                        print!("{}", text);
                    }
                },
                Err(e) => {
                    eprintln!("Error creating verification plan: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::Verify {
            base,
            head,
            fail_fast,
            no_persist,
            format,
        } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let repo_root = fdx::paths::find_repository_root(&cwd).unwrap_or(cwd);
            let format = parse_format(&format);

            let plan = match fdx::intelligence::testplan::planner::plan_verification(
                &repo_root,
                base.as_deref(),
                head.as_deref(),
                None,
            ) {
                Ok(p) => p,
                Err(e) => {
                    eprintln!("Error creating verification plan: {}", e);
                    process::exit(1);
                }
            };

            let options = fdx::intelligence::verify::VerificationExecutorOptions {
                bounds: fdx::intelligence::verify::ProcessBounds::default(),
                fail_fast,
                persist: !no_persist,
                base: base.clone(),
                head: head.clone(),
            };

            match fdx::intelligence::verify::execute_verification_plan(&repo_root, &plan, &options)
            {
                Ok(run) => {
                    match format {
                        OutputFormat::Json => {
                            if let Ok(json_str) = serde_json::to_string_pretty(&run) {
                                println!("{}", json_str);
                            }
                        }
                        OutputFormat::Text => {
                            let text =
                                fdx::intelligence::verify::format_verification_run_text(&run);
                            print!("{}", text);
                        }
                    }
                    // Optional M8 history ingestion: failure never alters M7 verification truth
                    // Only ingest if M7 persisted the artifact to disk, establishing exact artifact bytes
                    if let fdx::intelligence::verify::model::PersistenceStatus::Persisted {
                        ref path,
                    } = run.persistence_status
                    {
                        let artifact_path = repo_root.join(path);
                        if let Ok(raw_bytes) = std::fs::read(&artifact_path) {
                            if let Ok(mut db) = fdx::intelligence::db::EvidenceDatabase::open(
                                &repo_root,
                                fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
                            ) {
                                let _ = fdx::intelligence::runtime::ingest_verification_artifact(
                                    &mut db.conn,
                                    &raw_bytes,
                                );
                            }
                        }
                    }

                    if run.outcome != fdx::intelligence::verify::VerificationOutcome::Passed {
                        process::exit(1);
                    }
                }
                Err(e) => {
                    eprintln!("Error executing verification plan: {}", e);
                    process::exit(1);
                }
            }
        }

        Commands::History { action } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let repo_root = fdx::paths::find_repository_root(&cwd).unwrap_or(cwd);

            match action {
                HistoryAction::Runs { limit, format } => {
                    let format = parse_format(&format);
                    let db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadOnly,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database: {}", e);
                            process::exit(1);
                        }
                    };
                    match fdx::intelligence::runtime::list_historical_runs(&db.conn, limit) {
                        Ok(runs) => match format {
                            OutputFormat::Json => {
                                if let Ok(s) = serde_json::to_string_pretty(&runs) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!("Historical Verification Runs (showing up to {}):", limit);
                                for r in &runs {
                                    println!("- Run: {} | Outcome: {:?} | Assurance: {:?} | Executed: {} | Duration: {}ms",
                                        r.run_id, r.outcome, r.assurance, r.executed_at_ms, r.duration_ms);
                                }
                            }
                        },
                        Err(e) => {
                            eprintln!("Error querying historical runs: {}", e);
                            process::exit(1);
                        }
                    }
                }
                HistoryAction::Show { run_id, format } => {
                    let format = parse_format(&format);
                    let db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadOnly,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database: {}", e);
                            process::exit(1);
                        }
                    };
                    match fdx::intelligence::runtime::get_historical_run(&db.conn, &run_id) {
                        Ok(Some((run, executions, checks))) => match format {
                            OutputFormat::Json => {
                                let obj = serde_json::json!({
                                    "run": run,
                                    "executions": executions,
                                    "checks": checks,
                                });
                                if let Ok(s) = serde_json::to_string_pretty(&obj) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!("Run ID: {}", run.run_id);
                                println!("Outcome: {:?}", run.outcome);
                                println!("Assurance: {:?}", run.assurance);
                                println!("Duration: {}ms", run.duration_ms);
                                println!("Executions ({} total):", executions.len());
                                for e in &executions {
                                    println!(
                                        "  - {} (status: {:?}, exit: {:?}, dur: {}ms)",
                                        e.execution_id, e.status, e.exit_code, e.duration_ms
                                    );
                                }
                                println!("Checks ({} total):", checks.len());
                                for c in &checks {
                                    println!(
                                        "  - {} -> exec: {} (status: {:?}, reused: {})",
                                        c.check_id, c.execution_id, c.status, c.reused_execution
                                    );
                                }
                            }
                        },
                        Ok(None) => {
                            eprintln!("Run '{}' not found in history database.", run_id);
                            process::exit(1);
                        }
                        Err(e) => {
                            eprintln!("Error querying run details: {}", e);
                            process::exit(1);
                        }
                    }
                }
                HistoryAction::Stats { check_id, format } => {
                    let format = parse_format(&format);
                    let db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadOnly,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database: {}", e);
                            process::exit(1);
                        }
                    };
                    match fdx::intelligence::runtime::query_check_statistics(&db.conn, &check_id) {
                        Ok(Some(stats)) => match format {
                            OutputFormat::Json => {
                                if let Ok(s) = serde_json::to_string_pretty(&stats) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!("Historical Statistics for Check: {}", stats.check_id);
                                println!("Total Observations: {}", stats.total_observations);
                                println!("Unique Executions: {}", stats.unique_executions);
                                println!("Pass Count: {}", stats.pass_count);
                                println!("Failure Count: {}", stats.real_failure_count);
                                println!("Incomplete Count: {}", stats.incomplete_count);
                                if let Some(m) = stats.median_duration_ms {
                                    println!("Median Duration: {:.2}ms", m);
                                }
                                if let Some(p) = stats.p95_duration_ms {
                                    println!("P95 Duration: {:.2}ms", p);
                                }
                                println!(
                                    "Flake Signal Present: {}",
                                    stats.flake_signal.is_flake_signal_present
                                );
                            }
                        },
                        Ok(None) => {
                            eprintln!("No historical observations found for check '{}'.", check_id);
                            process::exit(1);
                        }
                        Err(e) => {
                            eprintln!("Error querying check statistics: {}", e);
                            process::exit(1);
                        }
                    }
                }
                HistoryAction::Cooccurrences { check_id, format } => {
                    let format = parse_format(&format);
                    let db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadOnly,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database: {}", e);
                            process::exit(1);
                        }
                    };
                    match fdx::intelligence::runtime::query_check_cooccurrences(&db.conn, &check_id)
                    {
                        Ok(obs) => match format {
                            OutputFormat::Json => {
                                if let Ok(s) = serde_json::to_string_pretty(&obs) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!(
                                    "Co-occurring Changed Entities with Check '{}':",
                                    check_id
                                );
                                for o in &obs {
                                    println!(
                                        "- Entity: {} ({}) | Runs: {} | Last Seen: {}",
                                        o.entity_id,
                                        o.entity_kind,
                                        o.run_count,
                                        o.last_observed_at_ms
                                    );
                                }
                            }
                        },
                        Err(e) => {
                            eprintln!("Error querying co-occurrences: {}", e);
                            process::exit(1);
                        }
                    }
                }
                HistoryAction::Reconcile { format } => {
                    let format = parse_format(&format);
                    let mut db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadWrite,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database for write: {}", e);
                            process::exit(1);
                        }
                    };
                    match fdx::intelligence::runtime::reconcile_runs_directory(
                        &mut db.conn,
                        &repo_root,
                    ) {
                        Ok(report) => {
                            match format {
                                OutputFormat::Json => {
                                    if let Ok(s) = serde_json::to_string_pretty(&report) {
                                        println!("{}", s);
                                    }
                                }
                                OutputFormat::Text => {
                                    println!("History Reconciliation Report:");
                                    println!("Discovered: {}", report.artifacts_discovered);
                                    println!("Imported: {}", report.artifacts_imported);
                                    println!(
                                        "Already Present: {}",
                                        report.artifacts_already_present
                                    );
                                    println!("Conflicted: {}", report.artifacts_conflicted);
                                    println!("Failed: {}", report.artifacts_failed);
                                    println!("Complete: {}", report.is_complete);
                                    for err in &report.errors {
                                        eprintln!("  Error: {}", err);
                                    }
                                }
                            }
                            if !report.is_complete {
                                process::exit(1);
                            }
                        }
                        Err(e) => {
                            eprintln!("Error during reconciliation: {}", e);
                            process::exit(1);
                        }
                    }
                }
            }
        }

        Commands::Attest { action } => {
            let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
            let repo_root = fdx::paths::find_repository_root(&cwd).unwrap_or(cwd);

            match action {
                AttestAction::Create { run, format } => {
                    let format = parse_format(&format);
                    let db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadOnly,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database: {}", e);
                            process::exit(1);
                        }
                    };

                    let attestation =
                        match fdx::intelligence::attestation::build_verification_attestation(
                            &repo_root, &run, &db.conn,
                        ) {
                            Ok(a) => a,
                            Err(e) => {
                                eprintln!("Error building verification attestation: {}", e);
                                process::exit(1);
                            }
                        };

                    match fdx::intelligence::attestation::persist_attestation(
                        &repo_root,
                        &attestation,
                    ) {
                        Ok((path, sha256)) => match format {
                            OutputFormat::Json => {
                                let obj = serde_json::json!({
                                    "status": "created",
                                    "run_id": run,
                                    "path": path,
                                    "attestation_sha256": sha256,
                                    "artifact_sha256": attestation.predicate.run.artifact_sha256,
                                    "statement": attestation,
                                });
                                if let Ok(s) = serde_json::to_string_pretty(&obj) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!("Verification Attestation Created:");
                                println!("  Run ID: {}", run);
                                println!("  Attestation SHA-256: {}", sha256);
                                println!(
                                    "  Artifact SHA-256: {}",
                                    attestation.predicate.run.artifact_sha256
                                );
                                println!("  Outcome: {:?}", attestation.predicate.result.outcome);
                                println!(
                                    "  Assurance: {:?}",
                                    attestation.predicate.result.assurance
                                );
                                println!("  Path: {:?}", path);
                            }
                        },
                        Err(e) => {
                            eprintln!("Error persisting attestation: {}", e);
                            process::exit(1);
                        }
                    }
                }
                AttestAction::Verify {
                    file,
                    expected_sha256,
                    format,
                } => {
                    let format = parse_format(&format);
                    let db = match fdx::intelligence::db::EvidenceDatabase::open(
                        &repo_root,
                        fdx::intelligence::db::DatabaseOpenMode::ReadOnly,
                    ) {
                        Ok(d) => d,
                        Err(e) => {
                            eprintln!("Error opening history database: {}", e);
                            process::exit(1);
                        }
                    };

                    let (statement, raw_bytes, _file_sha) =
                        match fdx::intelligence::attestation::load_attestation_from_path(
                            &repo_root,
                            &file,
                            expected_sha256.as_deref(),
                        ) {
                            Ok(res) => res,
                            Err(e) => {
                                eprintln!("Error loading attestation file: {}", e);
                                process::exit(1);
                            }
                        };

                    match fdx::intelligence::attestation::verify_attestation(
                        &repo_root,
                        &statement,
                        Some(&raw_bytes),
                        expected_sha256.as_deref(),
                        &db.conn,
                    ) {
                        Ok(report) => match format {
                            OutputFormat::Json => {
                                if let Ok(s) = serde_json::to_string_pretty(&report) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!("Verification Attestation Verified:");
                                println!("  Valid: {}", report.valid);
                                println!("  Run ID: {}", report.run_id);
                                println!("  Attestation SHA-256: {}", report.attestation_sha256);
                                println!("  Artifact SHA-256: {}", report.artifact_sha256);
                                println!("  Outcome: {:?}", report.outcome);
                                println!("  Assurance: {:?}", report.assurance);
                                println!("  Checks Verified: {}", report.checks_verified);
                                println!("  Executions Verified: {}", report.executions_verified);
                                println!(
                                    "  Global History Complete at Generation: {}",
                                    report.global_history_complete_at_generation
                                );
                            }
                        },
                        Err(e) => {
                            eprintln!("Attestation verification failed: {}", e);
                            process::exit(1);
                        }
                    }
                }
                AttestAction::Show { file, format } => {
                    let format = parse_format(&format);
                    let (statement, _bytes, file_sha) =
                        match fdx::intelligence::attestation::load_attestation_from_path(
                            &repo_root, &file, None,
                        ) {
                            Ok(res) => res,
                            Err(e) => {
                                eprintln!("Error loading attestation file: {}", e);
                                process::exit(1);
                            }
                        };

                    match format {
                        OutputFormat::Json => {
                            if let Ok(s) = serde_json::to_string_pretty(&statement) {
                                println!("{}", s);
                            }
                        }
                        OutputFormat::Text => {
                            println!("Verification Attestation Statement:");
                            println!("  Type: {}", statement.statement_type);
                            println!("  Predicate Type: {}", statement.predicate_type);
                            println!("  File SHA-256: {}", file_sha);
                            println!("  Run ID: {}", statement.predicate.run.run_id);
                            println!(
                                "  Artifact SHA-256: {}",
                                statement.predicate.run.artifact_sha256
                            );
                            println!("  Plan SHA-256: {}", statement.predicate.run.plan_sha256);
                            println!("  Outcome: {:?}", statement.predicate.result.outcome);
                            println!("  Assurance: {:?}", statement.predicate.result.assurance);
                            println!(
                                "  Total Obligations: {}",
                                statement.predicate.plan.total_obligations
                            );
                            println!("  Checks ({}):", statement.predicate.checks.len());
                            for c in &statement.predicate.checks {
                                println!(
                                    "    - {} (status: {:?}, physical: {}, reused: {})",
                                    c.check_id,
                                    c.status,
                                    c.has_physical_execution,
                                    c.reused_execution
                                );
                            }
                            println!("  Executions ({}):", statement.predicate.executions.len());
                            for e in &statement.predicate.executions {
                                println!(
                                    "    - {} (prog: {}, status: {:?}, dur: {}ms)",
                                    e.execution_id, e.program, e.status, e.duration_ms
                                );
                            }
                            if !statement.predicate.uncertainty.is_empty() {
                                println!(
                                    "  Uncertainty ({}):",
                                    statement.predicate.uncertainty.len()
                                );
                                for u in &statement.predicate.uncertainty {
                                    println!("    - [{}] {}", u.code, u.message);
                                }
                            }
                        }
                    }
                }
                AttestAction::List { format } => {
                    let format = parse_format(&format);
                    match fdx::intelligence::attestation::list_attestations(&repo_root) {
                        Ok(list) => match format {
                            OutputFormat::Json => {
                                if let Ok(s) = serde_json::to_string_pretty(&list) {
                                    println!("{}", s);
                                }
                            }
                            OutputFormat::Text => {
                                println!("Discovered Attestations ({}):", list.len());
                                for a in &list {
                                    println!(
                                        "- Run: {} | Outcome: {:?} | Assurance: {:?} | Attestation SHA: {} | Path: {:?}",
                                        a.run_id, a.outcome, a.assurance, a.attestation_sha256, a.path
                                    );
                                }
                            }
                        },
                        Err(e) => {
                            eprintln!("Error listing attestations: {}", e);
                            process::exit(1);
                        }
                    }
                }
            }
        }
    }
}

fn parse_mode(mode: &str) -> ReadMode {
    match mode.parse::<ReadMode>() {
        Ok(m) => m,

        Err(e) => {
            eprintln!("Error: {}", e);
            process::exit(1);
        }
    }
}

fn parse_format(format: &str) -> OutputFormat {
    match format.parse::<OutputFormat>() {
        Ok(f) => f,
        Err(e) => {
            eprintln!("Error: {}", e);
            process::exit(1);
        }
    }
}

/// Reconstruct the full grep output as a string for teeing.
fn build_full_grep_output(
    files: &[fdx::reader::grep::GrepFileResult],
    total_matches: usize,
) -> String {
    use std::fmt::Write as _;
    let mut output = String::new();
    for file in files {
        let _ = writeln!(
            &mut output,
            "[file] {}  ({} matches)",
            file.path,
            file.matches.len()
        );
        for m in &file.matches {
            for ctx in &m.context_before {
                let _ = writeln!(&mut output, "  {}", ctx);
            }
            let _ = writeln!(&mut output, "  L{}: {}", m.line_number, m.text);
            for ctx in &m.context_after {
                let _ = writeln!(&mut output, "  {}", ctx);
            }
        }
    }
    let _ = writeln!(
        &mut output,
        "{} match{} across {} file{}",
        total_matches,
        if total_matches == 1 { "" } else { "es" },
        files.len(),
        if files.len() == 1 { "" } else { "s" }
    );
    output
}
