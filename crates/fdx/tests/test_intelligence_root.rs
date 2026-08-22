
use fdx::paths::find_repository_root;
use tempfile::tempdir;
use std::fs;
use std::path::Path;

#[test]
fn test_find_repository_root() {
    let dir = tempdir().unwrap();
    let root = dir.path();
    
    // Create nested directory
    let nested = root.join("src").join("deep").join("nested");
    fs::create_dir_all(&nested).unwrap();
    
    // Without a .git folder, find_repository_root should fallback to canonical current_dir
    let resolved = find_repository_root(&nested).unwrap();
    // Because tempdir might be inside a real git repo (like /tmp which isn't), we'll just check if it finds the git root.
    // Let's create an explicit git repo inside tempdir
    
    std::process::Command::new("git")
        .arg("init")
        .current_dir(root)
        .output()
        .unwrap();
        
    let resolved_from_nested = find_repository_root(&nested).unwrap();
    assert_eq!(resolved_from_nested.canonicalize().unwrap(), root.canonicalize().unwrap());
    
    let resolved_from_root = find_repository_root(root).unwrap();
    assert_eq!(resolved_from_root.canonicalize().unwrap(), root.canonicalize().unwrap());
}
