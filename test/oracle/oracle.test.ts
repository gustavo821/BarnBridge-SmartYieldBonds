// needs to be added to each test so path aliases work
import 'tsconfig-paths/register';

import { expect } from 'chai';
import { Signer, Wallet, BigNumber as BN } from 'ethers';
import { BigNumber as BNj } from 'bignumber.js';
import { deployContract } from 'ethereum-waffle';

import { bbFixtures, e18, MAX_UINT256, A_DAY, BLOCKS_PER_DAY, ERROR_MARGIN_PREFERED, e, deployUnderlying, deployCompComptroller, deployCompCTokenDump, deployYieldOracle, deployCompoundController, deployClockMock, moveTime, currentTime } from '@testhelp/index';

import OraclelizedMockArtifact from '../../artifacts/contracts/mocks/barnbridge/OraclelizedMock.sol/OraclelizedMock.json';
import { OraclelizedMock } from '@typechain/OraclelizedMock';

const defaultWindowSize = A_DAY * 3;
const defaultGranularity = 12 * 3; // samples in window

const yieldPerPeriod = (yieldPerDay: BN, underlying: BN, windowSize: number, granularity: number, underlyingDecimals: number) => {
  const period = BN.from(windowSize).div(granularity);
  return underlying.mul(yieldPerDay).mul(period).div(A_DAY).div(e(1, underlyingDecimals));
};

const cTokenAPY = (supplyRatePerBlock: number | string | BN, days: number): BNj => {
  const rate = new BNj(supplyRatePerBlock.toString());
  return rate.div(e18(1).toString()).times(BLOCKS_PER_DAY).plus(1).pow(days - 1).minus(1);
};

const totalYieldExpected = (underlying: number | string | BN, supplyRatePerBlock: number | string | BN, days: number) => {
  const apy = cTokenAPY(supplyRatePerBlock, days).times(e18(1).toString()).toFixed(0);
  return BN.from(underlying).mul(apy).div(e18(1)).add(parseInt((days / 2).toString()) + 2);
};

const addCumulativeYield = (pool: OraclelizedMock) => {
  return async (newYield: BN | number, atTimestamp: number | BN) => {
    const newCumulativeSecondlyYieldLast = (await pool.cumulativeSecondlyYieldLast()).add(newYield);
    await pool.setCumulativeSecondlyYieldLast(newCumulativeSecondlyYieldLast, atTimestamp);
  };
};

const sumTo = (a: (BN | number)[], to: number) => {
  return a.slice(0, to + 1).reduce((prev: BN, c: BN | number) => BN.from(prev).add(c), BN.from(0));
};

const fixture = (windowSize: number, granularity: number) => {
  const decimals = 18;
  return async (wallets: Wallet[]) => {
    const [deployerSign, ownerSign] = wallets;
    const [deployerAddr, ownerAddr] = await Promise.all([
      deployerSign.getAddress(),
      ownerSign.getAddress(),
    ]);

    const clock = await deployClockMock(deployerSign);

    const [underlying, comptrollerMock, pool] = await Promise.all([
      deployUnderlying(deployerSign, decimals),
      deployCompComptroller(deployerSign),
      (deployContract(deployerSign, OraclelizedMockArtifact, [clock.address])) as Promise<OraclelizedMock>,
    ]);

    const [controller, cToken, yieldOracle] = await Promise.all([
      deployCompoundController(deployerSign),
      deployCompCTokenDump(deployerSign, underlying, comptrollerMock),
      deployYieldOracle(deployerSign, pool, windowSize, granularity),
    ]);

    await Promise.all([
      comptrollerMock.setHolder(pool.address),
      comptrollerMock.setMarket(cToken.address),
      controller.setOracle(yieldOracle.address),
      pool.setup('0x0000000000000000000000000000000000000000', controller.address, cToken.address),
    ]);

    await (moveTime(clock))(0);

    return {
      yieldOracle, pool, controller,
      deployerSign: deployerSign as Signer,
      ownerSign: ownerSign as Signer,
      deployerAddr, ownerAddr,
      moveTime: moveTime(clock),
      addCumulativeYield: addCumulativeYield(pool),
    };
  };
};

describe('Yield Oracle', async function () {
  it('should deploy YieldOracle correctly', async function () {
    const { yieldOracle, pool, controller } = await bbFixtures(fixture(defaultWindowSize, defaultGranularity));

    expect(await yieldOracle.pool()).equals(pool.address, 'Oraclelized address');
    expect(await controller.oracle()).equals(yieldOracle.address, 'Yield Oracle address');
    expect(await pool.controller()).equals(controller.address, 'Controller address');
    expect(await yieldOracle.windowSize()).deep.equals(BN.from(defaultWindowSize), 'Oracle windowSize');
    expect(await yieldOracle.granularity()).equals(defaultGranularity, 'Oracle granularity');
    expect(await yieldOracle.periodSize()).deep.equals(BN.from(defaultWindowSize).div(defaultGranularity), 'Oracle periodSize');
    expect(await yieldOracle.consult(A_DAY)).deep.equals(BN.from(0), 'First consult should zero');
  });

  it('should overflow as expected', async function () {
    const { pool } = await bbFixtures(fixture(defaultWindowSize, defaultGranularity));
    expect(await pool.cumulativeOverflowProof(0)).deep.equals(BN.from(0), 'should be 0');
    expect(await pool.cumulativeOverflowProof(1)).deep.equals(BN.from(1), 'should be 1');
    expect(await pool.cumulativeOverflowProof(1000000)).deep.equals(BN.from(1000000), 'should be 1000000');
    expect(await pool.cumulativeOverflowProof(MAX_UINT256)).deep.equals(MAX_UINT256, 'should be MAX_UINT256');
  });

  describe('update()', () => {

    it('should properly compute avg yield for examples', async function () {
      const days = 3;
      const windowSize = A_DAY * days;
      const granularity = 2 * days;

      const yields = [50, 40, 60, 45, 50, 55, 40, 40, 40]; // ~ yield every half a day
      const expectedYields = [100, 100, 92, 90]; // resulting daily yields

      const { yieldOracle: oracle, pool, moveTime, addCumulativeYield } = await bbFixtures(fixture(windowSize, granularity));

      for (let i = 0; i < yields.length; i++) {
        await moveTime(windowSize / granularity);
        await addCumulativeYield(yields[i], currentTime());
        await oracle.update();
        if (i < granularity - 1) {
          expect(await oracle.consult(A_DAY), `consult sould be 0 when not enought obs in window. i=${i}`).deep.equal(BN.from(0));
        } else {
          const expected = BN.from(expectedYields[i - granularity + 1]);
          expect(await oracle.consult(A_DAY), `consult sould be ${expect}. i=${i}`).deep.equal(expected);
        }
      }
    });


    it('should properly extrapolate avg yield', async function () {
      const underlyingDecimals = 18;
      const days = 3;
      const windowSize = A_DAY * days;
      const granularity = 2 * days;
      const yieldPerDay = BN.from(23456518266).mul(BLOCKS_PER_DAY);
      const yieldPerPeriod = yieldPerDay.mul(windowSize / granularity).div(A_DAY);

      const { yieldOracle: oracle, pool, moveTime, addCumulativeYield } = await bbFixtures(fixture(windowSize, granularity));

      const underlying = e('1.3', underlyingDecimals);

      for (let i = 0; i < granularity * 2; i++) {
        await moveTime(windowSize / granularity);

        await addCumulativeYield(yieldPerPeriod, currentTime());

        await pool['setUnderlyingBalance(uint256,uint256)'](underlying, underlying);
        await oracle.update();
        if (i < granularity - 1) {
          expect(await oracle.consult(A_DAY), `should be 0 for i=${i}`).deep.equal(BN.from(0));
        } else {
          expect(await oracle.consult(A_DAY), `should be ${yieldPerDay} for i=${i}`).deep.equal(yieldPerDay);
        }
      }
    });
  });

  describe('happy paths with cumulate()', () => {

    it('should not bork for large underlying (9t)(e18)', async function () {
      const underlyingDecimals = 18;
      const days = 6;
      const windowSize = A_DAY * days;
      const granularity = 2 * days;
      const yield_per_day = BN.from(23456518266).mul(BLOCKS_PER_DAY);

      let underlying = e('9000000000000', underlyingDecimals);

      const { yieldOracle, pool, moveTime } = await bbFixtures(fixture(windowSize, granularity));

      expect(await yieldOracle.consult(A_DAY)).deep.equals(BN.from(0), 'should be 0');

      for (let i = 0; i < granularity * 2; i++) {
        underlying = underlying.add(yieldPerPeriod(yield_per_day, underlying, windowSize, granularity, underlyingDecimals));
        await pool.setUnderlyingBalanceAndCumulate(underlying);
        if (i < granularity - 1) {
          expect(await yieldOracle.consult(A_DAY), `should be 0 for i=${i}`).deep.equal(BN.from(0));
        } else {
          expect(await yieldOracle.consult(A_DAY), `should be ${yield_per_day} for i=${i}`).equalOrLowerWithin(yield_per_day, ERROR_MARGIN_PREFERED); // off by 2?
        }
        await moveTime(windowSize / granularity);
      }
    }).timeout(100 * 1000);

    it('should not bork for small underlying (1)(e18)', async function () {
      const underlyingDecimals = 18;
      const days = 13;
      const windowSize = A_DAY * days;
      const granularity = 1 * days;
      const blockYield = 23456518261;
      const yield_per_day = BN.from(blockYield).mul(BLOCKS_PER_DAY);
      let underlying = e(1, underlyingDecimals);
      const statingUnderlying = underlying;

      const { yieldOracle, pool, moveTime } = await bbFixtures(fixture(windowSize, granularity));
      expect(await yieldOracle.consult(A_DAY)).deep.equals(BN.from(0), 'should be 0');

      await pool.setUnderlyingBalanceAndCumulate(underlying);
      await moveTime(windowSize / granularity);

      for (let i = 0; i < granularity * 2; i++) {
        underlying = underlying.add(yieldPerPeriod(yield_per_day, underlying, windowSize, granularity, underlyingDecimals));
        await pool.setUnderlyingBalanceAndCumulate(underlying);
        if (i < granularity - 2) {
          expect(await yieldOracle.consult(A_DAY), `should be 0 for i=${i}`).deep.equal(BN.from(0));
        } else {
          expect(await yieldOracle.consult(A_DAY), `should be ${yield_per_day} for i=${i}`).equalOrLowerWithin(yield_per_day, ERROR_MARGIN_PREFERED); // off by 1
        }
        await moveTime(windowSize / granularity);
      }
    }).timeout(100 * 1000);
  });
});