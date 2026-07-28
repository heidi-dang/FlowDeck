//! Log parsing and error excerpt extraction for CI failure reports.

/// Extract the first relevant error block from a CI log.
pub fn extract_error_excerpt(log: &str, max_chars: usize) -> String {
    let mut excerpt = String::new();
    let mut _in_error = false;
    let mut context_lines = 0;

    for line in log.lines() {
        if context_lines > 0 {
            if excerpt.len() + line.len() + 1 > max_chars {
                break;
            }
            excerpt.push_str(line);
            excerpt.push('\n');
            context_lines -= 1;
            continue;
        }

        if line.contains("error")
            || line.contains("Error")
            || line.contains("FAILED")
            || line.contains("failure")
            || line.contains("panicked")
            || line.contains("exit code")
        {
            _in_error = true;
            if excerpt.len() + line.len() + 1 > max_chars {
                break;
            }
            excerpt.push_str(line);
            excerpt.push('\n');
            context_lines = 5;
        }
    }

    if excerpt.is_empty() {
        let end = log.len().min(max_chars);
        return log[..end].to_string();
    }

    excerpt
}

/// Extract exit code from a CI log line.
pub fn extract_exit_code(log: &str) -> Option<i32> {
    let re = regex::Regex::new(r"exit code (\d+)").ok()?;
    if let Some(cap) = re.captures(log) {
        return cap[1].parse().ok();
    }
    let re2 = regex::Regex::new(r"Process completed with exit code (\d+)").ok()?;
    re2.captures(log).and_then(|cap| cap[1].parse().ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_exit_code() {
        assert_eq!(
            extract_exit_code("Process completed with exit code 1."),
            Some(1)
        );
        assert_eq!(extract_exit_code("exit code 101"), Some(101));
        assert_eq!(extract_exit_code("no error here"), None);
    }

    #[test]
    fn test_extract_error_excerpt_basic() {
        let log = "line1\nline2\nerror: something broke\nline4\nline5\nline6\nline7\nok";
        let excerpt = extract_error_excerpt(log, 200);
        assert!(excerpt.contains("error: something broke"));
        assert!(excerpt.contains("line4"));
        assert!(excerpt.contains("line5"));
    }
}
