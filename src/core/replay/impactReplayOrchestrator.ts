/**
 * impactReplayOrchestrator.ts
 *
 * Auto-navigates through diagram layers when functions change,
 * showing the impact chain: L5 Flow → L3 Sequence → L2a Feature.
 */

import type { Snapshot, DiagramGraph } from '../graph/graphTypes';
import type { ChangeDetail } from './changeLog';
import { analyzeImpact } from '../analysis/impactAnalyzer';

type ViewMode = 'sequence' | 'file' | 'flow' | 'feature' | 'microservice' | 'api-list' | 'health' | 'map' | 'domain' | 'tour';

export interface ReplayStep {
    graphId: string;
    mode: ViewMode;
    label: string;
    functionName: string;
    filePath: string;
    layer: string;
}

interface ReplayCallbacks {
    navigate: (graphId: string, mode: ViewMode, graph: DiagramGraph, label: string) => void;
    onStepStart: (step: ReplayStep, index: number, total: number) => void;
    onReplayStart: (totalSteps: number) => void;
    onReplayStop: () => void;
    getGraph: (graphId: string) => DiagramGraph | undefined;
}

export class ImpactReplayOrchestrator {
    private isPlaying = false;
    private currentTimer: ReturnType<typeof setTimeout> | null = null;
    private stepDurationMs: number;

    constructor(
        private callbacks: ReplayCallbacks,
        stepDurationMs = 2500,
    ) {
        this.stepDurationMs = stepDurationMs;
    }

    /**
     * Build the replay sequence for a set of change details, then play it.
     */
    async play(details: ChangeDetail[], snapshot: Snapshot): Promise<void> {
        this.stop();

        const steps: ReplayStep[] = [];

        for (const detail of details) {
            const allChangedFns = [...detail.changedFunctions, ...detail.newFunctions];
            if (allChangedFns.length === 0) continue;

            // Run impact analysis for this file
            const impact = analyzeImpact([detail.filePath], snapshot);

            for (const fnName of allChangedFns) {
                // Step 1: L5 Flow chart for the changed function
                const flowId = `flow:${detail.filePath}:${fnName}`;
                steps.push({
                    graphId: flowId,
                    mode: 'flow',
                    label: `Flow: ${fnName}`,
                    functionName: fnName,
                    filePath: detail.filePath,
                    layer: 'L5 Flow',
                });

                // Step 2: L3 Sequence diagram (if this function is an API handler)
                const seqIds = impact.affectedSequenceGraphIds ?? [];
                const matchingSeq = seqIds.find(id => id.includes(fnName)) ?? seqIds[0];
                if (matchingSeq) {
                    steps.push({
                        graphId: matchingSeq,
                        mode: 'sequence',
                        label: `Sequence: ${fnName}`,
                        functionName: fnName,
                        filePath: detail.filePath,
                        layer: 'L3 Sequence',
                    });
                }

                // Step 3: L2a Feature cluster
                if (impact.affectedClusterIds.length > 0) {
                    // Navigate to the feature diagram for the service (or workspace)
                    const serviceId = snapshot.clusters?.[impact.affectedClusterIds[0]]?.serviceId;
                    const featureId = serviceId ? `feature:${serviceId}` : 'feature:workspace';
                    steps.push({
                        graphId: featureId,
                        mode: 'feature',
                        label: 'Feature Areas',
                        functionName: fnName,
                        filePath: detail.filePath,
                        layer: 'L2a Feature',
                    });
                }
            }
        }

        if (steps.length === 0) return;

        this.isPlaying = true;
        this.callbacks.onReplayStart(steps.length);

        for (let i = 0; i < steps.length; i++) {
            if (!this.isPlaying) break;

            const step = steps[i];
            const graph = this.callbacks.getGraph(step.graphId);
            if (!graph) continue; // Skip if graph doesn't exist

            this.callbacks.onStepStart(step, i, steps.length);
            this.callbacks.navigate(step.graphId, step.mode, graph, step.label);

            // Wait before next step
            if (i < steps.length - 1) {
                await this.delay(this.stepDurationMs);
                if (!this.isPlaying) break;
            }
        }

        this.isPlaying = false;
        this.callbacks.onReplayStop();
    }

    stop(): void {
        this.isPlaying = false;
        if (this.currentTimer) {
            clearTimeout(this.currentTimer);
            this.currentTimer = null;
        }
        // Resolve any pending delay
        if (this.delayResolve) {
            this.delayResolve();
            this.delayResolve = null;
        }
    }

    get active(): boolean {
        return this.isPlaying;
    }

    private delayResolve: (() => void) | null = null;

    private delay(ms: number): Promise<void> {
        return new Promise(resolve => {
            this.delayResolve = resolve;
            this.currentTimer = setTimeout(() => {
                this.delayResolve = null;
                resolve();
            }, ms);
        });
    }
}
