// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CutButton } from './CutButton';

it('renders CutButton', () => {
  render(<CutButton>Save</CutButton>);
 expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
});