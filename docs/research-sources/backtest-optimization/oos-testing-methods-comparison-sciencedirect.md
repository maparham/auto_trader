# Backtest overfitting in the machine learning era: A comparison of out-of-sample testing methods in a synthetic controlled environment

Source: https://www.sciencedirect.com/science/article/abs/pii/S0950705124011110
Saved as text on 2026-07-16 (paywalled article; abstract and introduction preview only).

Authors: Hamid Arian (York University), Daniel Norouzi Mobarekeh (RiskLab, University of
Toronto), Luis Seco (University of Toronto). Knowledge-Based Systems, Volume 305, Article
112477, 3 December 2024. DOI: 10.1016/j.knosys.2024.112477

Keywords: Quantitative finance; Machine learning; Cross-validation; Probability of backtest
overfitting

## Abstract

We present a comprehensive framework to assess these methods, considering the unique
characteristics of financial data like non-stationarity, autocorrelation, and regime shifts.
Through our analysis, we unveil the marked superiority of the Combinatorial Purged (CPCV)
method in mitigating overfitting risks, outperforming traditional methods as evidenced by its
lower Probability of Backtest Overfitting (PBO) and superior Deflated Sharpe Ratio (DSR) test
statistic. Walk-Forward, by contrast, exhibits notable shortcomings in false discovery
prevention, characterized by increased temporal variability and weaker stationarity. This
contrasts with CPCV's demonstrable stability and efficiency. We introduce novel variants of
CPCV, including Bagged CPCV and Adaptive CPCV, which enhance robustness through ensemble
approaches and dynamic adjustments based on market conditions. Our empirical validation using
historical SP 500 data confirms these advanced cross-validation methods' practical
applicability and resilience. The analysis also suggests that choosing between Purged K-Fold
and K-Fold necessitates caution due to their comparable performance and potential impact on
the robustness of training data in out-of-sample testing. Our investigation utilizes a
Synthetic Controlled Environment incorporating advanced models like the Heston Stochastic
Volatility, Merton Jump Diffusion, and Drift-Burst Hypothesis alongside regime-switching
models. This approach provides a nuanced simulation of market conditions, offering new
insights into evaluating cross-validation techniques. We also address the computational
aspects of these methods, demonstrating that parallelization significantly improves
efficiency, making them feasible for large-scale financial datasets. Our study underscores the
necessity of specialized validation methods in financial modeling, especially in the face of
growing regulatory demands and complex market dynamics.

## Introduction (highlights from the free preview)

- Conventional cross-validation methods (K-Fold, Walk-Forward) show limitations on financial
  data because they do not account for temporal dependencies and non-stationarity.
- Lopez de Prado's Purged K-Fold adds a purging mechanism that removes training data that
  could leak information about the test set (lookahead bias prevention).
- Combinatorial Purged Cross-Validation (CPCV) creates multiple training/testing combinations
  so each data segment is used for training and validation, giving a more comprehensive
  assessment across market scenarios while respecting chronological ordering.
- Bailey, Borwein, Lopez de Prado and Zhu introduced quantifiable metrics: Probability of
  Backtest Overfitting (PBO) and the Deflated Sharpe Ratio (DSR), providing a statistical
  basis to assess reliability of backtested strategies.
- The study's Synthetic Controlled Environment merges the Heston stochastic volatility model,
  the Merton jump diffusion model, the drift-burst hypothesis for short-lived anomalies, and a
  Markov chain regime-switching model, simulating calm, volatile, and speculative bubble
  regimes.
- Novel contributions: Adaptive CPCV and Bagged CPCV variants designed for non-stationarity
  and regime shifts; empirical validation on S&P 500 data; open-source implementations by
  RiskLabAI (Python and Julia libraries).
- Noted limitation: the computational intensity of advanced cross-validation methods,
  especially CPCV, could limit practical application without substantial computational
  resources; parallelization mitigates this.
