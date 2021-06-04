import 'tsconfig-paths/register';

import { deployBondModelV2Compounded } from '@testhelp/index';
import { Wallet, BigNumber as BN } from 'ethers';
import { run, ethers } from 'hardhat';

async function main() {

  const [deployerSign, ...signers] = (await ethers.getSigners()) as unknown[] as Wallet[];

  console.log('Deployer:', deployerSign.address);
  console.log('Others:', signers.map(a => a.address));

  const bondModel = await deployBondModelV2Compounded(deployerSign);

  console.log('CONF --------');
  console.log('');
  console.log('DEPLOYED ----');
  console.log('bondModel:', bondModel.address);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
