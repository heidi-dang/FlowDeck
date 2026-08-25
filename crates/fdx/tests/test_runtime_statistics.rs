use fdx::intelligence::runtime::compute_percentiles;

#[test]
fn test_runtime_deterministic_percentiles_calculation() {
    let samples = vec![10, 20, 30, 40, 50];
    let (median, p95) = compute_percentiles(&samples);
    assert_eq!(median, Some(30.0));
    assert_eq!(p95, Some(50.0));

    let even_samples = vec![10, 20, 30, 40];
    let (median_even, p95_even) = compute_percentiles(&even_samples);
    assert_eq!(median_even, Some(25.0));
    assert_eq!(p95_even, Some(40.0));
}
