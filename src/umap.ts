/* Copyright 2019 Google LLC. All Rights Reserved.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/

/**
 * This is a JavaScript reimplementation of UMAP (original license below), from
 * the python implementation found at https://github.com/lmcinnes/umap.
 *
 * @author andycoenen@google.com (Andy Coenen)
 */

/**
 * @license
 * BSD 3-Clause License
 *
 * Copyright (c) 2017, Leland McInnes
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are met:
 *
 * * Redistributions of source code must retain the above copyright notice, this
 *   list of conditions and the following disclaimer.
 *
 * * Redistributions in binary form must reproduce the above copyright notice,
 *   this list of conditions and the following disclaimer in the documentation
 *   and/or other materials provided with the distribution.
 *
 * * Neither the name of the copyright holder nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 * AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 * IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
 * FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
 * DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
 * CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
 * OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
 * OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

import * as matrix from './matrix';
import * as nnDescent from './nn_descent';
import * as tree from './tree';
import * as utils from './utils';
import * as LM from 'ml-levenberg-marquardt';

export type DistanceFn = (x: Vector, y: Vector) => number;
export type EpochCallback = (epoch: number) => boolean | void;
export type Vector = number[];
export type Vectors = Vector[];
export const enum TargetMetric {
  categorical = 'categorical',
  l1 = 'l1',
  l2 = 'l2',
}

const SMOOTH_K_TOLERANCE = 1e-5;
const MIN_K_DIST_SCALE = 1e-3;

export interface UMAPParameters {
  /**
   * The effective minimum distance between embedded points. Smaller values
   * will result in a more clustered/clumped embedding where nearby points
   * on the manifold are drawn closer together, while larger values will
   * result on a more even dispersal of points. The value should be set
   * relative to the ``spread`` value, which determines the scale at which
   * embedded points will be spread out.
   */
  minDist?: number;
  /**
   * The dimension of the space to embed into. This defaults to 2 to
   * provide easy visualization, but can reasonably be set to any
   * integer value in the range 2 to 100.
   */

  nComponents?: number;
  /**
   * The number of training epochs to be used in optimizing the
   * low dimensional embedding. Larger values result in more accurate
   * embeddings. If None is specified a value will be selected based on
   * the size of the input dataset (200 for large datasets, 500 for small).
   */

  nEpochs?: number;
  /**
   * The size of local neighborhood (in terms of number of neighboring
   * sample points) used for manifold approximation. Larger values
   * result in more global views of the manifold, while smaller
   * values result in more local data being preserved. In general
   * values should be in the range 2 to 100.
   */

  nNeighbors?: number;
  /**
   * The pseudo-random number generator used by the stochastic parts of the
   * algorithm.
   */
  random?: () => number;
  /**
   * The effective scale of embedded points. In combination with ``min_dist``
   * this determines how clustered/clumped the embedded points are.
   */
  spread?: number;
}

export interface UMAPSupervisedParams {
  /**
   * The metric used to measure distance for a target array is using supervised
   * dimension reduction. By default this is 'categorical' which will measure
   * distance in terms of whether categories match or are different. Furthermore,
   * if semi-supervised is required target values of -1 will be treated as
   * unlabelled under the 'categorical' metric. If the target array takes
   * continuous values (e.g. for a regression problem) then metric of 'l1'
   * or 'l2' is probably more appropriate.
   */
  targetMetric?: TargetMetric;
  /**
   * Weighting factor between data topology and target topology. A value of
   * 0.0 weights entirely on data, a value of 1.0 weights entirely on target.
   * The default of 0.5 balances the weighting equally between data and target.
   */
  targetWeight?: number;
  /**
   * The number of nearest neighbors to use to construct the target simplcial
   * set. Defaults to the `nearestNeighbors` parameter.
   */
  targetNNeighbors?: number;
}

/**
 * UMAP projection system, based on the python implementation from McInnes, L,
 * Healy, J, UMAP: Uniform Manifold Approximation and Projection for Dimension
 * Reduction (https://github.com/lmcinnes/umap).
 *
 * This implementation differs in a few regards:
 * a) The initialization of the embedding for optimization is not computed using
 *    a spectral method, rather it is initialized randomly. This avoids some
 *    computationally intensive matrix eigen computations that aren't easily
 *    ported to JavaScript.
 * b) A lot of "extra" functionality has been omitted from this implementation,
 *    most notably a great deal of alternate distance functions, the ability
 *    to do supervised projection, and the ability to transform additional data
 *    into an existing embedding space.
 *
 * This implementation provides three methods of reducing dimensionality:
 * 1) fit: fit the data synchronously
 * 2) fitAsync: fit the data asynchronously, with a callback function provided
 *      that is invoked on each optimization step.
 * 3) initializeFit / step: manually initialize the algorithm then explictly
 *      step through each epoch of the SGD optimization
 */
export class UMAP {
  private minDist = 0.1;
  private nComponents = 2;
  private nEpochs = 0;
  private nNeighbors = 15;
  private random = Math.random;
  private spread = 1.0;

  // Supervised projection params
  private targetMetric = TargetMetric.categorical;
  private targetWeight = 0.5;
  private targetNNeighbors = this.nNeighbors;

  private distanceFn: DistanceFn = euclidean;

  // KNN state (can be precomputed and supplied via initializeFit)
  private knnIndices?: number[][];
  private knnDistances?: number[][];

  // Internal graph connectivity representation
  private graph!: matrix.SparseMatrix;
  private X!: Vectors;
  private isInitialized = false;

  // Supervised projection labels / targets
  private Y?: number[];

  // Projected embedding
  private embedding: number[][] = [];
  private optimizationState = new OptimizationState();

  constructor(params: UMAPParameters = {}) {
    this.minDist = params.minDist || this.minDist;
    this.nComponents = params.nComponents || this.nComponents;
    this.nEpochs = params.nEpochs || this.nEpochs;
    this.nNeighbors = params.nNeighbors || this.nNeighbors;
    this.random = params.random || this.random;
    this.spread = params.spread || this.spread;
  }

  /**
   * Fit the data to a projected embedding space synchronously.
   */
  fit(X: Vectors) {
    this.initializeFit(X);
    this.optimizeLayout();

    return this.embedding;
  }

  /**
   * Fit the data to a projected embedding space asynchronously, with a callback
   * function invoked on every epoch of optimization.
   */
  async fitAsync(
    X: Vectors,
    callback: (epochNumber: number) => void | boolean = () => true
  ) {
    this.initializeFit(X);

    await this.optimizeLayout(callback);
    return this.embedding;
  }

  /**
   * Initializes parameters needed for supervised projection.
   */
  setSupervisedProjection(Y: number[], params: UMAPSupervisedParams = {}) {
    this.Y = Y;
    this.targetMetric = params.targetMetric || this.targetMetric;
    this.targetWeight = params.targetWeight || this.targetWeight;
    this.targetNNeighbors = params.targetNNeighbors || this.targetNNeighbors;
  }

  /**
   * Initializes umap with precomputed KNN indices and distances.
   */
  setPrecomputedKNN(knnIndices: number[][], knnDistances: number[][]) {
    this.knnIndices = knnIndices;
    this.knnDistances = knnDistances;
  }

  /**
   * Initializes fit by computing KNN and a fuzzy simplicial set, as well as
   * initializing the projected embeddings. Sets the optimization state ahead
   * of optimization steps. Returns the number of epochs to be used for the
   * SGD optimization.
   */
  initializeFit(X: Vectors): number {
    // We don't need to reinitialize if we've already initialized for this data.
    if (this.X === X && this.isInitialized) {
      return this.getNEpochs();
    }

    this.X = X;

    if (!this.knnIndices && !this.knnDistances) {
      const knnResults = this.nearestNeighbors(X);
      this.knnIndices = knnResults.knnIndices;
      this.knnDistances = knnResults.knnDistances;
    }

    this.graph = this.fuzzySimplicialSet(X, this.nNeighbors);

    // Check if supervised projection, then adjust the graph.
    this.processGraphForSupervisedProjection();

    const {
      head,
      tail,
      epochsPerSample,
    } = this.initializeSimplicialSetEmbedding();

    // Set the optimization routine state
    this.optimizationState.head = head;
    this.optimizationState.tail = tail;
    this.optimizationState.epochsPerSample = epochsPerSample;

    this.isInitialized = true;
    return this.getNEpochs();
  }

  /**
   * Checks if we're using supervised projection, then process the graph
   * accordingly.
   */
  private processGraphForSupervisedProjection() {
    const { Y, X } = this;
    if (Y) {
      if (Y.length !== X.length) {
        throw new Error('Length of X and y must be equal');
      }

      if (this.targetMetric === TargetMetric.categorical) {
        const lt = this.targetWeight < 1.0;
        const farDist = lt ? 2.5 * (1.0 / (1.0 - this.targetWeight)) : 1.0e12;
        this.graph = this.categoricalSimplicialSetIntersection(
          this.graph,
          Y,
          farDist
        );
      }
      // TODO (andycoenen@): add non-categorical supervised embeddings.
    }
  }

  /**
   * Manually step through the optimization process one epoch at a time.
   */
  step() {
    const { currentEpoch, isInitialized } = this.optimizationState;
    if (!isInitialized) {
      this.initializeOptimization();
    }

    if (currentEpoch < this.getNEpochs()) {
      this.optimizeLayoutStep(currentEpoch);
    }
    return this.optimizationState.currentEpoch;
  }

  /**
   * Returns the computed projected embedding.
   */
  getEmbedding() {
    return this.embedding;
  }

  /**
   * Compute the ``nNeighbors`` nearest points for each data point in ``X``
   * This may be exact, but more likely is approximated via nearest neighbor
   * descent.
   */
  private nearestNeighbors(X: Vectors) {
    const { distanceFn, nNeighbors } = this;
    const log2 = (n: number) => Math.log(n) / Math.log(2);
    const metricNNDescent = nnDescent.makeNNDescent(distanceFn, this.random);

    // Handle python3 rounding down from 0.5 discrpancy
    const round = (n: number) => {
      return n === 0.5 ? 0 : Math.round(n);
    };

    const nTrees = 5 + Math.floor(round(X.length ** 0.5 / 20.0));
    const nIters = Math.max(5, Math.floor(Math.round(log2(X.length))));

    const rpForest = tree.makeForest(X, nNeighbors, nTrees, this.random);

    const leafArray = tree.makeLeafArray(rpForest);
    const { indices, weights } = metricNNDescent(
      X,
      leafArray,
      nNeighbors,
      nIters
    );
    return { knnIndices: indices, knnDistances: weights };
  }

  /**
   * Given a set of data X, a neighborhood size, and a measure of distance
   * compute the fuzzy simplicial set (here represented as a fuzzy graph in
   * the form of a sparse matrix) associated to the data. This is done by
   * locally approximating geodesic distance at each point, creating a fuzzy
   * simplicial set for each such point, and then combining all the local
   * fuzzy simplicial sets into a global one via a fuzzy union.
   */
  private fuzzySimplicialSet(
    X: Vectors,
    nNeighbors: number,
    localConnectivity = 1.0,
    setOpMixRatio = 1.0
  ) {
    const { knnIndices = [], knnDistances = [] } = this;

    const { sigmas, rhos } = this.smoothKNNDistance(
      knnDistances,
      nNeighbors,
      localConnectivity
    );

    const { rows, cols, vals } = this.computeMembershipStrengths(
      knnIndices,
      knnDistances,
      sigmas,
      rhos
    );

    const size = [X.length, X.length];
    const sparseMatrix = new matrix.SparseMatrix(rows, cols, vals, size);

    const transpose = matrix.transpose(sparseMatrix);
    const prodMatrix = matrix.pairwiseMultiply(sparseMatrix, transpose);

    const a = matrix.subtract(matrix.add(sparseMatrix, transpose), prodMatrix);
    const b = matrix.multiplyScalar(a, setOpMixRatio);
    const c = matrix.multiplyScalar(prodMatrix, 1.0 - setOpMixRatio);
    const result = matrix.add(b, c);

    return result;
  }

  /**
   * Combine a fuzzy simplicial set with another fuzzy simplicial set
   * generated from categorical data using categorical distances. The target
   * data is assumed to be categorical label data (a vector of labels),
   * and this will update the fuzzy simplicial set to respect that label data.
   */
  private categoricalSimplicialSetIntersection(
    simplicialSet: matrix.SparseMatrix,
    target: number[],
    farDist: number,
    unknownDist = 1.0
  ) {
    let intersection = fastIntersection(
      simplicialSet,
      target,
      unknownDist,
      farDist
    );
    intersection = matrix.eliminateZeros(intersection);
    return resetLocalConnectivity(intersection);
  }

  /**
   * Compute a continuous version of the distance to the kth nearest
   * neighbor. That is, this is similar to knn-distance but allows continuous
   * k values rather than requiring an integral k. In esscence we are simply
   * computing the distance such that the cardinality of fuzzy set we generate
   * is k.
   */
  private smoothKNNDistance(
    distances: Vectors,
    k: number,
    localConnectivity = 1.0,
    nIter = 64,
    bandwidth = 1.0
  ) {
    const target = (Math.log(k) / Math.log(2)) * bandwidth;
    const rho = utils.zeros(distances.length);
    const result = utils.zeros(distances.length);

    for (let i = 0; i < distances.length; i++) {
      let lo = 0.0;
      let hi = Infinity;
      let mid = 1.0;

      // TODO: This is very inefficient, but will do for now. FIXME
      const ithDistances = distances[i];
      const nonZeroDists = ithDistances.filter(d => d > 0.0);

      if (nonZeroDists.length >= localConnectivity) {
        let index = Math.floor(localConnectivity);
        let interpolation = localConnectivity - index;
        if (index > 0) {
          rho[i] = nonZeroDists[index - 1];
          if (interpolation > SMOOTH_K_TOLERANCE) {
            rho[i] +=
              interpolation * (nonZeroDists[index] - nonZeroDists[index - 1]);
          }
        } else {
          rho[i] = interpolation * nonZeroDists[0];
        }
      } else if (nonZeroDists.length > 0) {
        rho[i] = utils.max(nonZeroDists);
      }

      for (let n = 0; n < nIter; n++) {
        let psum = 0.0;
        for (let j = 1; j < distances[i].length; j++) {
          const d = distances[i][j] - rho[i];
          if (d > 0) {
            psum += Math.exp(-(d / mid));
          } else {
            psum += 1.0;
          }
        }

        if (Math.abs(psum - target) < SMOOTH_K_TOLERANCE) {
          break;
        }

        if (psum > target) {
          hi = mid;
          mid = (lo + hi) / 2.0;
        } else {
          lo = mid;
          if (hi === Infinity) {
            mid *= 2;
          } else {
            mid = (lo + hi) / 2.0;
          }
        }
      }

      result[i] = mid;

      // TODO: This is very inefficient, but will do for now. FIXME
      if (rho[i] > 0.0) {
        const meanIthDistances = utils.mean(ithDistances);
        if (result[i] < MIN_K_DIST_SCALE * meanIthDistances) {
          result[i] = MIN_K_DIST_SCALE * meanIthDistances;
        }
      } else {
        const meanDistances = utils.mean(distances.map(utils.mean));
        if (result[i] < MIN_K_DIST_SCALE * meanDistances) {
          result[i] = MIN_K_DIST_SCALE * meanDistances;
        }
      }
    }

    return { sigmas: result, rhos: rho };
  }

  /**
   * Construct the membership strength data for the 1-skeleton of each local
   * fuzzy simplicial set -- this is formed as a sparse matrix where each row is
   * a local fuzzy simplicial set, with a membership strength for the
   * 1-simplex to each other data point.
   */
  private computeMembershipStrengths(
    knnIndices: Vectors,
    knnDistances: Vectors,
    sigmas: number[],
    rhos: number[]
  ): { rows: number[]; cols: number[]; vals: number[] } {
    const nSamples = knnIndices.length;
    const nNeighbors = knnIndices[0].length;

    const rows = utils.zeros(nSamples * nNeighbors);
    const cols = utils.zeros(nSamples * nNeighbors);
    const vals = utils.zeros(nSamples * nNeighbors);

    for (let i = 0; i < nSamples; i++) {
      for (let j = 0; j < nNeighbors; j++) {
        let val = 0;
        if (knnIndices[i][j] === -1) {
          continue; // We didn't get the full knn for i
        }
        if (knnIndices[i][j] === i) {
          val = 0.0;
        } else if (knnDistances[i][j] - rhos[i] <= 0.0) {
          val = 1.0;
        } else {
          val = Math.exp(-((knnDistances[i][j] - rhos[i]) / sigmas[i]));
        }

        rows[i * nNeighbors + j] = i;
        cols[i * nNeighbors + j] = knnIndices[i][j];
        vals[i * nNeighbors + j] = val;
      }
    }

    return { rows, cols, vals };
  }

  /**
   * Initialize a fuzzy simplicial set embedding, using a specified
   * initialisation method and then minimizing the fuzzy set cross entropy
   * between the 1-skeletons of the high and low dimensional fuzzy simplicial
   * sets.
   */
  private initializeSimplicialSetEmbedding() {
    const nEpochs = this.getNEpochs();

    const { nComponents } = this;
    const graphValues = this.graph.getValues();
    let graphMax = 0;
    for (let i = 0; i < graphValues.length; i++) {
      const value = graphValues[i];
      if (graphMax < graphValues[i]) {
        graphMax = value;
      }
    }

    const graph = this.graph.map(value => {
      if (value < graphMax / nEpochs) {
        return 0;
      } else {
        return value;
      }
    });

    // We're not computing the spectral initialization in this implementation
    // until we determine a better eigenvalue/eigenvector computation
    // approach
    this.embedding = utils.zeros(graph.nRows).map(() => {
      return utils.zeros(nComponents).map(() => {
        return utils.tauRand(this.random) * 20 + -10; // Random from -10 to 10
      });
    });

    // Get graph data in ordered way...
    const weights: number[] = [];
    const head: number[] = [];
    const tail: number[] = [];
    for (let i = 0; i < graph.nRows; i++) {
      for (let j = 0; j < graph.nCols; j++) {
        const value = graph.get(i, j);
        if (value) {
          weights.push(value);
          tail.push(i);
          head.push(j);
        }
      }
    }
    const epochsPerSample = this.makeEpochsPerSample(weights, nEpochs);

    return { head, tail, epochsPerSample };
  }

  /**
   * Given a set of weights and number of epochs generate the number of
   * epochs per sample for each weight.
   */
  private makeEpochsPerSample(weights: number[], nEpochs: number) {
    const result = utils.filled(weights.length, -1.0);
    const max = utils.max(weights);
    const nSamples = weights.map(w => (w / max) * nEpochs);
    nSamples.forEach((n, i) => {
      if (n > 0) result[i] = nEpochs / nSamples[i];
    });
    return result;
  }

  /**
   * Initializes optimization state for stepwise optimization
   */
  private initializeOptimization() {
    // Algorithm state
    const headEmbedding = this.embedding;
    const tailEmbedding = this.embedding;

    // Initialized in initializeSimplicialSetEmbedding()
    const { head, tail, epochsPerSample } = this.optimizationState;

    // Hyperparameters
    const gamma = 1.0;
    const initialAlpha = 1.0;
    const negativeSampleRate = 5;

    const nEpochs = this.getNEpochs();
    const nVertices = this.graph.nCols;

    const { a, b } = findABParams(this.spread, this.minDist);

    const dim = headEmbedding[0].length;
    const moveOther = headEmbedding.length === tailEmbedding.length;
    let alpha = initialAlpha;

    const epochsPerNegativeSample = epochsPerSample.map(
      e => e / negativeSampleRate
    );
    const epochOfNextNegativeSample = [...epochsPerNegativeSample];
    const epochOfNextSample = [...epochsPerSample];

    Object.assign(this.optimizationState, {
      isInitialized: true,
      headEmbedding,
      tailEmbedding,
      head,
      tail,
      epochsPerSample,
      epochOfNextSample,
      epochOfNextNegativeSample,
      epochsPerNegativeSample,
      moveOther,
      initialAlpha,
      alpha,
      gamma,
      a,
      b,
      dim,
      nEpochs,
      nVertices,
    });
  }

  /**
   * Improve an embedding using stochastic gradient descent to minimize the
   * fuzzy set cross entropy between the 1-skeletons of the high dimensional
   * and low dimensional fuzzy simplicial sets. In practice this is done by
   * sampling edges based on their membership strength (with the (1-p) terms
   * coming from negative sampling similar to word2vec).
   */
  private optimizeLayoutStep(n: number) {
    const { optimizationState } = this;
    const {
      head,
      tail,
      headEmbedding,
      tailEmbedding,
      epochsPerSample,
      epochOfNextSample,
      epochOfNextNegativeSample,
      epochsPerNegativeSample,
      moveOther,
      initialAlpha,
      alpha,
      gamma,
      a,
      b,
      dim,
      nEpochs,
      nVertices,
    } = optimizationState;

    const clipValue = 4.0;

    for (let i = 0; i < epochsPerSample.length; i++) {
      if (epochOfNextSample[i] > n) {
        continue;
      }

      const j = head[i];
      const k = tail[i];

      const current = headEmbedding[j];
      const other = tailEmbedding[k];

      const distSquared = rDist(current, other);

      let gradCoeff = 0;
      if (distSquared > 0) {
        gradCoeff = -2.0 * a * b * Math.pow(distSquared, b - 1.0);
        gradCoeff /= a * Math.pow(distSquared, b) + 1.0;
      }

      for (let d = 0; d < dim; d++) {
        const gradD = clip(gradCoeff * (current[d] - other[d]), clipValue);
        current[d] += gradD * alpha;
        if (moveOther) {
          other[d] += -gradD * alpha;
        }
      }

      epochOfNextSample[i] += epochsPerSample[i];

      const nNegSamples = Math.floor(
        (n - epochOfNextNegativeSample[i]) / epochsPerNegativeSample[i]
      );

      for (let p = 0; p < nNegSamples; p++) {
        const k = utils.tauRandInt(nVertices, this.random);
        const other = tailEmbedding[k];

        const distSquared = rDist(current, other);

        let gradCoeff = 0.0;
        if (distSquared > 0.0) {
          gradCoeff = 2.0 * gamma * b;
          gradCoeff /=
            (0.001 + distSquared) * (a * Math.pow(distSquared, b) + 1);
        } else if (j === k) {
          continue;
        }

        for (let d = 0; d < dim; d++) {
          let gradD = 4.0;
          if (gradCoeff > 0.0) {
            gradD = clip(gradCoeff * (current[d] - other[d]), clipValue);
          }
          current[d] += gradD * alpha;
        }
      }
      epochOfNextNegativeSample[i] += nNegSamples * epochsPerNegativeSample[i];
    }
    optimizationState.alpha = initialAlpha * (1.0 - n / nEpochs);

    optimizationState.currentEpoch += 1;
    this.embedding = headEmbedding;
    return optimizationState.currentEpoch;
  }

  /**
   * Improve an embedding using stochastic gradient descent to minimize the
   * fuzzy set cross entropy between the 1-skeletons of the high dimensional
   * and low dimensional fuzzy simplicial sets. In practice this is done by
   * sampling edges based on their membership strength (with the (1-p) terms
   * coming from negative sampling similar to word2vec).
   */
  private optimizeLayout(
    epochCallback: (epochNumber: number) => void | boolean = () => true
  ): Promise<boolean> {
    if (!this.optimizationState.isInitialized) {
      this.initializeOptimization();
    }

    return new Promise((resolve, reject) => {
      const step = async () => {
        try {
          const { nEpochs, currentEpoch } = this.optimizationState;
          const epochCompleted = this.optimizeLayoutStep(currentEpoch);
          const shouldStop = epochCallback(epochCompleted) === false;
          const isFinished = epochCompleted === nEpochs;
          if (!shouldStop && !isFinished) {
            step();
          } else {
            return resolve(isFinished);
          }
        } catch (err) {
          reject(err);
        }
      };
      step();
    });
  }

  /**
   * Gets the number of epochs for optimizing the projection.
   * NOTE: This heuristic differs from the python version
   */
  private getNEpochs() {
    const graph = this.graph;

    if (this.nEpochs > 0) {
      return this.nEpochs;
    }

    const length = graph.nRows;
    if (length <= 2500) {
      return 500;
    } else if (length <= 5000) {
      return 400;
    } else if (length <= 7500) {
      return 300;
    } else {
      return 200;
    }
  }
}

export function euclidean(x: Vector, y: Vector) {
  let result = 0;
  for (let i = 0; i < x.length; i++) {
    result += (x[i] - y[i]) ** 2;
  }
  return Math.sqrt(result);
}

export function cosine(x: Vector, y: Vector) {
  let result = 0.0;
  let normX = 0.0;
  let normY = 0.0;

  for (let i = 0; i < x.length; i++) {
    result += x[i] * y[i];
    normX += x[i] ** 2;
    normY += y[i] ** 2;
  }

  if (normX === 0 && normY === 0) {
    return 0;
  } else if (normX === 0 || normY === 0) {
    return 1.0;
  } else {
    return 1.0 - result / Math.sqrt(normX * normY);
  }
}

/**
 * An interface representing the optimization state tracked between steps of
 * the SGD optimization
 */
class OptimizationState {
  currentEpoch = 0;
  isInitialized = false;

  // Data tracked during optimization steps.
  headEmbedding: number[][] = [];
  tailEmbedding: number[][] = [];
  head: number[] = [];
  tail: number[] = [];
  epochsPerSample: number[] = [];
  epochOfNextSample: number[] = [];
  epochOfNextNegativeSample: number[] = [];
  epochsPerNegativeSample: number[] = [];
  moveOther = true;
  initialAlpha = 1.0;
  alpha = 1.0;
  gamma = 1.0;
  a = 1.5769434603113077;
  b = 0.8950608779109733;
  dim = 2;
  nEpochs = 500;
  nVertices = 0;
}

/**
 * Standard clamping of a value into a fixed range
 */
function clip(x: number, clipValue: number) {
  if (x > clipValue) return clipValue;
  else if (x < -clipValue) return -clipValue;
  else return x;
}

/**
 * Reduced Euclidean distance.
 */
function rDist(x: number[], y: number[]) {
  let result = 0.0;
  for (let i = 0; i < x.length; i++) {
    result += Math.pow(x[i] - y[i], 2);
  }
  return result;
}

/**
 * Fit a, b params for the differentiable curve used in lower
 * dimensional fuzzy simplicial complex construction. We want the
 * smooth curve (from a pre-defined family with simple gradient) that
 * best matches an offset exponential decay.
 */
export function findABParams(spread: number, minDist: number) {
  const curve = ([a, b]) => (x: number) => {
    return 1.0 / (1.0 + a * x ** (2 * b));
  };

  const xv = utils
    .linear(0, spread * 3, 300)
    .map(val => (val < minDist ? 1.0 : val));

  const yv = utils.zeros(xv.length).map((val, index) => {
    const gte = xv[index] >= minDist;
    return gte ? Math.exp(-(xv[index] - minDist) / spread) : val;
  });

  const initialValues = [0.5, 0.5];
  const data = { x: xv, y: yv };

  // Default options for the algorithm (from github example)
  const options = {
    damping: 1.5,
    initialValues,
    gradientDifference: 10e-2,
    maxIterations: 100,
    errorTolerance: 10e-3,
  };

  const { parameterValues } = LM(data, curve, options);
  const [a, b] = parameterValues as number[];
  return { a, b };
}

/**
 * Under the assumption of categorical distance for the intersecting
 * simplicial set perform a fast intersection.
 */
export function fastIntersection(
  graph: matrix.SparseMatrix,
  target: number[],
  unknownDist = 1.0,
  farDist = 5.0
) {
  return graph.map((value, row, col) => {
    if (target[row] === -1 || target[col] === -1) {
      return value * Math.exp(-unknownDist);
    } else if (target[row] !== target[col]) {
      return value * Math.exp(-farDist);
    } else {
      return value;
    }
  });
}

/**
 * Reset the local connectivity requirement -- each data sample should
 * have complete confidence in at least one 1-simplex in the simplicial set.
 * We can enforce this by locally rescaling confidences, and then remerging the
 * different local simplicial sets together.
 */
export function resetLocalConnectivity(simplicialSet: matrix.SparseMatrix) {
  simplicialSet = matrix.normalize(simplicialSet, matrix.NormType.max);
  const transpose = matrix.transpose(simplicialSet);
  const prodMatrix = matrix.pairwiseMultiply(transpose, simplicialSet);
  simplicialSet = matrix.add(
    simplicialSet,
    matrix.subtract(transpose, prodMatrix)
  );
  return matrix.eliminateZeros(simplicialSet);
}
