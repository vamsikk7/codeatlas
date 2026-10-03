import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OssInterestBanner } from './OssInterestBanner';

describe('OssInterestBanner', () => {
    beforeEach(() => localStorage.clear());

    it('renders a register-interest link to the dashboard when not dismissed', () => {
        render(<OssInterestBanner />);
        const link = screen.getByTestId('ca-oss-banner-link');
        expect(link.getAttribute('href')).toContain('codeatlas.live');
    });

    it('dismiss hides the banner and persists the choice', () => {
        render(<OssInterestBanner />);
        fireEvent.click(screen.getByTestId('ca-oss-banner-dismiss'));
        expect(screen.queryByTestId('ca-oss-banner')).toBeNull();
        expect(localStorage.getItem('codeatlas.ossInterestBannerDismissed')).toBe('1');
    });

    it('stays hidden when previously dismissed', () => {
        localStorage.setItem('codeatlas.ossInterestBannerDismissed', '1');
        render(<OssInterestBanner />);
        expect(screen.queryByTestId('ca-oss-banner')).toBeNull();
    });
});
