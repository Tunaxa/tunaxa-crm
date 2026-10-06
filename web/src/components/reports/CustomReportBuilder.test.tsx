// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { CustomReportBuilder } from './CustomReportBuilder';

it('renders the report builder', () => {
  render(<CustomReportBuilder />);
  expect(screen.getByText('Build Report')).toBeTruthy();
});