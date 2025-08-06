import { WalletClient } from '@bsv/sdk';
import { MessageBoxClient } from './MessageBoxClient.js'
import * as crypto from 'crypto'
(global.self as any) = { crypto };

// import { AuthFetch } from '@bsv/sdk'
(async () => {

  // const authFetch = new AuthFetch({
  //   authServer: 'https://auth.babbage.systems',
  //   walletServer: 'https://wallet.babbage.systems',
  //   clientId: 'dummy',
  //   clientSecret: 'dummy'
  // })

  const messageboxClient = new MessageBoxClient({
    host: 'http://localhost:8080',
    walletClient: new WalletClient('auto', 'http://localhost')
  })

  // const result = await messageboxClient.allowNotificationsFromPeer(
  //   '0350fa50d7c23f63d949c9532f41a7ea0c01112ffb1404cfb8a9f732b11a54a1ce',
  //   0
  // )

  // const result = await messageboxClient.checkPeerNotificationStatus('0350fa50d7c23f63d949c9532f41a7ea0c01112ffb1404cfb8a9f732b11a54a1ce')
  const result = await messageboxClient.sendNotification(
    '0350fa50d7c23f63d949c9532f41a7ea0c01112ffb1404cfb8a9f732b11a54a1ce',
    'Hello world'
  )

  // const result = await messageboxClient.registerDevice({
  //   fcmToken: 'fM0zqSpuQ3qBgKeTF3oTgx:APA91bEsLRcEgmjPOAeg4perQyznRQ9Ig7IYG-d2z4NbZRRMk4ZONXxmeAmhAoprnzl2Cg5-PbhiE0J40ZhesRZOWoefOfSA6Pk4vrqR0-jTMPfuS0dkJtw'
  // })

  console.log(result)
})().catch(console.error)

// TODO: Register device route
// Map identity key to devices
// Send to multiple FCM devices
