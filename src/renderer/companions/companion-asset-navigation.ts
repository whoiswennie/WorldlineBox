import { createContext } from 'react';
import type { CompanionAssetLocation } from '../../shared/companion-instance';
export const CompanionAssetNavigation = createContext<((location: CompanionAssetLocation) => void) | undefined>(undefined);
