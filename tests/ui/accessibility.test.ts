import { describe, expect, it } from 'bun:test';
import { Window } from 'happy-dom';
import axe from 'axe-core';
import { mountLiveDashboard } from '../../src/better-harness/ui/mount';

describe('Task 10: Automated Accessibility Scan & Semantic Validation', () => {
  it('should pass automated axe-core scan on mounted dashboard with 0 violations', async () => {
    const window = new Window();
    const document = window.document;
    const container = document.createElement('div');
    document.body.appendChild(container);

    const controller = mountLiveDashboard(container as any, {
      runId: 'run-a11y-1',
      featureFlagEnabled: false,
    });

    // Run axe accessibility scan
    const results = await axe.run(container as any, {
      rules: {
        'color-contrast': { enabled: false }, // CSS colors tested in visual engine
      },
    });

    controller.destroy();

    const violations = results.violations || [];
    if (violations.length > 0) {
      console.error('Accessibility violations found:', JSON.stringify(violations, null, 2));
    }
    expect(violations.length).toBe(0);
  });

  it('should maintain landmark structure, live regions, and keyboard focusable elements', () => {
    const window = new Window();
    const document = window.document;
    const container = document.createElement('div');
    document.body.appendChild(container);

    const controller = mountLiveDashboard(container as any, {
      runId: 'run-a11y-2',
      featureFlagEnabled: false,
    });

    const banner = container.querySelector('[role="banner"]');
    expect(banner).not.toBeNull();

    const liveRegions = container.querySelectorAll('[aria-live]');
    expect(liveRegions.length).toBeGreaterThan(0);

    const focusableItems = container.querySelectorAll('[tabindex="0"]');
    expect(focusableItems.length).toBeGreaterThan(0);

    controller.destroy();
  });
});
