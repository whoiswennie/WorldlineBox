import type * as PIXI from "pixi.js";
/**
 * Structural type describing the subset of a `pixi-live2d-display` model
 * instance that this renderer touches. Kept internal to the package.
 */
export type Live2DModelInstance = PIXI.Container & {
    anchor?: {
        set: (x: number, y?: number) => void;
    };
    expression?: (name: string) => Promise<boolean>;
    motion?: (group: string, index: number, priority: number) => Promise<boolean>;
    internalModel?: {
        originalWidth?: number;
        originalHeight?: number;
        localTransform?: PIXI.Matrix;
        getDrawableVertices?: (index: number) => Float32Array;
        eyeBlink?: unknown;
        motionManager?: {
            stopAllMotions(): void;
            expressionManager?: {
                currentExpression: unknown;
                defaultExpression: unknown;
                reserveExpressionIndex: number;
                stopAllExpressions(): void;
                resetExpression(): void;
            };
        };
        coreModel?: {
            getDrawableCount?: () => number;
            getDrawableOpacity?: (index: number) => number;
            getParameterIndex?: (id: string) => number;
            getParameterCount?: () => number;
            getParameterId?: (index: number) => string;
            getParameterMinimumValue?: (index: number) => number;
            getParameterMaximumValue?: (index: number) => number;
            getParameterDefaultValue?: (index: number) => number;
            getParameterValueByIndex?: (index: number) => number;
            setParameterValueByIndex?: (index: number, value: number, weight?: number) => void;
            saveParameters?: () => void;
            setParameterValueById?: (id: string, value: number, weight?: number) => void;
            _model?: {
                parameters?: {
                    ids?: string[];
                    minimumValues?: number[];
                    maximumValues?: number[];
                    defaultValues?: number[];
                };
            };
        };
        on?: (event: string, handler: () => void) => void;
        off?: (event: string, handler: () => void) => void;
    };
    autoUpdate?: boolean;
    destroy: (options?: unknown) => void;
};
