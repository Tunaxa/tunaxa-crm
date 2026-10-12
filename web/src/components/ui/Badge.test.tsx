// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from './Badge';

describe('Badge', () => {
  it('renders its children', () => {
    render(<Badge>Active</Badge>);

    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('uses the blue variant by default', () => {
    render(<Badge>Default</Badge>);

    expect(screen.getByText('Default').className).toContain('text-[#2563eb]');
  });

  it('applies the emerald style for the green tone', () => {
    render(<Badge tone="green">Success</Badge>);

    expect(screen.getByText('Success').className).toContain('text-emerald-700');
  });

  it('uses the explicit variant over the tone', () => {
    render(
      <Badge variant="red" tone="green">
        Error
      </Badge>,
    );

    expect(screen.getByText('Error').className).toContain('text-red-700');
  });

  it('preserves the custom className', () => {
    render(<Badge className="custom-class">Custom</Badge>);

    expect(screen.getByText('Custom').className).toContain('custom-class');
  });
});
