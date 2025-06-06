import { trace } from '@opentelemetry/api'
import _ from 'lodash'
import { serializeError } from 'serialize-error'
import VError from 'verror'
import { validateHmacSignature } from '../../utils/hmacValidator.js'
import utils from '../../utils/commons.js'
import ctp from '../../utils/ctp.js'
import config from '../../config/config.js'
import { getLogger } from '../../utils/logger.js'

const mainLogger = getLogger()

async function processNotification(
  notification,
  enableHmacSignature,
  ctpProjectConfig,
) {
  const span = trace.getActiveSpan()
  const logger = mainLogger.child({
    commercetools_project_key: ctpProjectConfig.projectKey,
  })

  if (enableHmacSignature) {
    const errorMessage = validateHmacSignature(notification)
    if (errorMessage) {
      logger.error(
        { notification: utils.getNotificationForTracking(notification) },
        `HMAC validation failed. Reason: "${errorMessage}"`,
      )
      return
    }
  }

  const merchantReference = _.get(
    notification,
    'NotificationRequestItem.merchantReference',
    null,
  )

  const pspReference = _.get(
    notification,
    'NotificationRequestItem.pspReference',
    null,
  )

  const originalReference = _.get(
    notification,
    'NotificationRequestItem.originalReference',
    null,
  )

  const ctpClient = await ctp.get(ctpProjectConfig)
  const maxRetry = 7
  let retryCount = 0

  const handleWebhook = async () => {
    let payment = await getPaymentByMerchantReference(
      merchantReference,
      originalReference || pspReference,
      ctpClient,
    )
    try {
      // if payment doesn't exist throw an error in order to retry fetching
      if (
        !payment ||
        !(
          payment.custom.fields.makePaymentResponse ||
          payment.custom.fields.createSessionResponse
        )
      ) {
        throwError(merchantReference)
      }

      // if payment has payment response or session response => updatePayment
      if (
        payment.custom.fields.makePaymentResponse ||
        payment.custom.fields.createSessionResponse
      ) {
        await updatePaymentWithRepeater(
          payment,
          notification,
          ctpClient,
          logger,
        )
      }
    } catch (err) {
      retryCount += 1
      // only if notification event code is authorization and max retry is not reached
      if (
        retryCount < maxRetry &&
        notification.NotificationRequestItem.eventCode === 'AUTHORISATION'
      ) {
        await sleep(1000)
        await handleWebhook()

        return
      }

      if (payment) {
        // if payment exists it should be updated
        // if pspReference or originalReference from webhook are the same as the payment key => standard update
        // if not => add a transaction with the message to the payment
        // so the merchant could see that the webhook wasn't correct
        await updatePaymentWithRepeater(
          payment,
          notification,
          ctpClient,
          logger,
        )
      }

      span?.recordException(err)
      logger.error(err)
    }
  }

  return handleWebhook()
}

function throwError(merchantReference) {
  const error = new Error(`Payment ${merchantReference} is not created yet.`)
  error.statusCode = 404

  throw new VError(error, `Payment ${merchantReference} is not created yet.`)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function updatePaymentWithRepeater(
  payment,
  notification,
  ctpClient,
  logger,
) {
  const span = trace.getActiveSpan()
  span?.setAttribute('payment', JSON.stringify(payment))

  const maxRetry = 20
  let currentPayment = payment
  let currentVersion = payment.version
  let retryCount = 0
  let retryMessage
  let updateActions
  const repeater = async () => {
    updateActions = await calculateUpdateActionsForPayment(
      currentPayment,
      notification,
      logger,
    )
    if (updateActions.length === 0) {
      return
    }
    logger.debug(
      `Update payment with key ${
        currentPayment.key
      } with update actions [${JSON.stringify(updateActions)}]`,
    )
    try {
      await ctpClient.update(
        ctpClient.builder.payments,
        currentPayment.id,
        currentVersion,
        updateActions,
      )
      logger.debug(
        `Payment with key ${currentPayment.key} was successfully updated`,
      )
    } catch (err) {
      const moduleConfig = config.getModuleConfig()
      let updateActionsToLog = updateActions
      if (moduleConfig.removeSensitiveData)
        updateActionsToLog =
          _obfuscateNotificationInfoFromActionFields(updateActions)

      span?.setAttribute('actions', JSON.stringify(updateActionsToLog))

      if (err.statusCode !== 409) {
        const errMsg =
          `Unexpected error on payment update with ID: ${currentPayment.id}.` +
          `Failed actions: ${JSON.stringify(updateActionsToLog)}`
        if (Array.isArray(err.body.errors) && err.body.errors.length > 0) {
          span?.setAttribute('errors', JSON.stringify(err.body.errors))
          span?.recordException(err.toString())
        }
        throw new VError(err, errMsg)
      }

      retryCount += 1
      if (retryCount > maxRetry) {
        retryMessage =
          'Got a concurrent modification error' +
          ` when updating payment with id "${currentPayment.id}".` +
          ` Version tried "${currentVersion}",` +
          ` currentVersion: "${err.body.errors[0].currentVersion}".`
        throw new VError(
          err,
          `${retryMessage} Won't retry again` +
            ` because of a reached limit ${maxRetry}` +
            ` max retries. Failed actions: ${JSON.stringify(
              updateActionsToLog,
            )}`,
        )
      }

      const response = await ctpClient.fetchById(
        ctpClient.builder.payments,
        currentPayment.id,
      )

      if (response?.body) {
        currentPayment = response.body
        currentVersion = currentPayment.version
      }

      await repeater()
    }
  }

  return repeater()
}

function _obfuscateNotificationInfoFromActionFields(updateActions) {
  const copyOfUpdateActions = _.cloneDeep(updateActions)
  copyOfUpdateActions
    .filter((value) => value.action === 'addInterfaceInteraction')
    .filter((value) => value?.fields?.notification)
    .forEach((value) => {
      value.fields.notification = utils.getNotificationForTracking(
        JSON.parse(value.fields.notification),
      )
    })
  return copyOfUpdateActions
}

async function calculateUpdateActionsForPayment(payment, notification, logger) {
  const updateActions = []
  const notificationRequestItem = notification.NotificationRequestItem
  const stringifiedNotification = JSON.stringify(notification)
  const { pspReference } = notificationRequestItem
  // check if the interfaceInteraction is already on payment or not
  const isNotificationInInterfaceInteraction =
    payment.interfaceInteractions.some(
      (interaction) =>
        interaction.fields.notification === stringifiedNotification,
    )
  if (isNotificationInInterfaceInteraction === false)
    updateActions.push(getAddInterfaceInteractionUpdateAction(notification))
  const { transactionType, transactionState } =
    await getTransactionTypeAndStateOrNull(notificationRequestItem)
  if (transactionType !== null) {
    // if there is already a transaction with type `transactionType` then update its `transactionState` if necessary,
    // otherwise create a transaction with type `transactionType` and state `transactionState`

    const { eventDate } = notificationRequestItem
    const oldTransaction = _.find(
      payment.transactions,
      (transaction) => transaction.interactionId === pspReference,
    )
    if (_.isEmpty(oldTransaction))
      updateActions.push(
        getAddTransactionUpdateAction({
          timestamp: convertDateToUTCFormat(eventDate, logger),
          type: transactionType,
          state: transactionState,
          amount: notificationRequestItem.amount.value,
          currency: notificationRequestItem.amount.currency,
          interactionId: pspReference,
        }),
      )
    else if (
      compareTransactionStates(oldTransaction.state, transactionState) > 0
    ) {
      updateActions.push(
        getChangeTransactionStateUpdateAction(
          oldTransaction.id,
          transactionState,
        ),
      )
      updateActions.push(
        getChangeTransactionTimestampUpdateAction(
          oldTransaction.id,
          notificationRequestItem.eventDate,
          logger,
        ),
      )
    }

    if (notificationRequestItem.success) {
      const paymentKey = payment.key
      const newPspReference =
        notificationRequestItem.originalReference || pspReference
      if (newPspReference && newPspReference !== paymentKey) {
        updateActions.push({
          action: 'setKey',
          key: newPspReference,
        })
      }
    }
  }

  const paymentMethodFromPayment = payment.paymentMethodInfo.method
  const paymentMethodFromNotification = notificationRequestItem.paymentMethod
  if (
    paymentMethodFromNotification &&
    paymentMethodFromPayment !== paymentMethodFromNotification
  ) {
    updateActions.push(
      getSetMethodInfoMethodAction(paymentMethodFromNotification),
    )
    const action = getSetMethodInfoNameAction(paymentMethodFromNotification)
    if (action) updateActions.push(action)
  }

  return updateActions
}

/**
 * Compares transaction states
 * @param currentState state of the transaction from the CT platform
 * @param newState state of the transaction from the Adyen notification
 * @return number 1 if newState can appear after currentState
 * -1 if newState cannot appear after currentState
 * 0 if newState is the same as currentState
 * @throws Error when newState and/or currentState is a wrong transaction state
 * */
function compareTransactionStates(currentState, newState) {
  const transactionStateFlow = {
    Initial: 0,
    Pending: 1,
    Success: 2,
    Failure: 3,
  }
  if (
    !transactionStateFlow.hasOwnProperty(currentState) ||
    !transactionStateFlow.hasOwnProperty(newState)
  ) {
    const errorMessage = `Wrong transaction state passed. CurrentState: ${currentState}, newState: ${newState}`
    throw new Error(errorMessage)
  }
  return transactionStateFlow[newState] - transactionStateFlow[currentState]
}

function getAddInterfaceInteractionUpdateAction(notification) {
  const moduleConfig = config.getModuleConfig()
  const notificationToUse = _.cloneDeep(notification)
  const eventCode = _.isNil(notificationToUse.NotificationRequestItem.eventCode)
    ? ''
    : notificationToUse.NotificationRequestItem.eventCode.toLowerCase()

  if (!notificationToUse.NotificationRequestItem.success) {
    return {
      action: 'addInterfaceInteraction',
      type: {
        key: 'ctp-adyen-integration-interaction-notification',
        typeId: 'type',
      },
      fields: {
        createdAt: new Date(),
        status: eventCode + '_failed',
        type: 'notification',
        notification: JSON.stringify(notificationToUse),
      },
    }
  }

  // Put the recurringDetailReference out of additionalData to avoid removal
  if (
    notificationToUse.NotificationRequestItem?.additionalData &&
    notificationToUse.NotificationRequestItem?.additionalData[
      'recurring.recurringDetailReference'
    ]
  ) {
    const recurringDetailReference =
      notificationToUse.NotificationRequestItem.additionalData[
        'recurring.recurringDetailReference'
      ]

    notificationToUse.NotificationRequestItem.recurringDetailReference =
      recurringDetailReference
  }

  if (
    notificationToUse.NotificationRequestItem?.additionalData &&
    notificationToUse.NotificationRequestItem?.additionalData[
      'recurringProcessingModel'
    ]
  ) {
    const { recurringProcessingModel } =
      notificationToUse.NotificationRequestItem.additionalData

    notificationToUse.NotificationRequestItem.recurringProcessingModel =
      recurringProcessingModel
  }

  if (
    notificationToUse.NotificationRequestItem?.additionalData &&
    notificationToUse.NotificationRequestItem?.additionalData[
      'recurring.shopperReference'
    ]
  ) {
    const recurringShopperReference =
      notificationToUse.NotificationRequestItem.additionalData[
        'recurring.shopperReference'
      ]

    notificationToUse.NotificationRequestItem.recurringShopperReference =
      recurringShopperReference
  }

  if (moduleConfig.removeSensitiveData) {
    // strip away sensitive data
    delete notificationToUse.NotificationRequestItem.additionalData
    delete notificationToUse.NotificationRequestItem.reason
  }

  return {
    action: 'addInterfaceInteraction',
    type: {
      key: 'ctp-adyen-integration-interaction-notification',
      typeId: 'type',
    },
    fields: {
      createdAt: new Date(),
      status: eventCode,
      type: 'notification',
      notification: JSON.stringify(notificationToUse),
    },
  }
}

function getChangeTransactionStateUpdateAction(
  transactionId,
  newTransactionState,
) {
  return {
    action: 'changeTransactionState',
    transactionId,
    state: newTransactionState,
  }
}

function convertDateToUTCFormat(transactionEventDate, logger) {
  try {
    // Assume transactionEventDate should be in correct format (e.g. '2019-01-30T18:16:22+01:00')
    const eventDateMilliSecondsStr = Date.parse(transactionEventDate)
    const transactionDate = new Date(eventDateMilliSecondsStr)
    return transactionDate.toISOString()
  } catch (err) {
    // if transactionEventDate is incorrect in format
    logger.error(
      err,
      `Fail to convert notification event date "${transactionEventDate}" to UTC format`,
    )
    return new Date().toISOString()
  }
}

function getChangeTransactionTimestampUpdateAction(
  transactionId,
  transactionEventDate,
  logger,
) {
  return {
    action: 'changeTransactionTimestamp',
    transactionId,
    timestamp: convertDateToUTCFormat(transactionEventDate, logger),
  }
}

async function getTransactionTypeAndStateOrNull(notificationRequestItem) {
  const adyenEvents = await utils.readAndParseJsonFile(
    'resources/adyen-events.json',
  )
  const adyenEventCode = notificationRequestItem.eventCode
  const adyenEventSuccess = notificationRequestItem.success

  const adyenEvent = _.find(
    adyenEvents,
    (e) => e.eventCode === adyenEventCode && e.success === adyenEventSuccess,
  )
  if (adyenEvent && adyenEventCode === 'CANCEL_OR_REFUND') {
    /* we need to get correct action from the additional data, for example:
     "NotificationRequestItem":{
        "additionalData":{
           "modification.action":"refund"
        }
        ...
      }
     */
    const modificationAction = notificationRequestItem.additionalData
      ? notificationRequestItem.additionalData['modification.action']
      : null
    if (modificationAction === 'refund') adyenEvent.transactionType = 'Refund'
    else if (modificationAction === 'cancel')
      adyenEvent.transactionType = 'CancelAuthorization'
  }
  return (
    adyenEvent || {
      eventCode: adyenEventCode,
      success: adyenEventSuccess,
      transactionType: null,
      transactionState: null,
    }
  )
}

function getAddTransactionUpdateAction({
  timestamp,
  type,
  state,
  amount,
  currency,
  interactionId,
}) {
  return {
    action: 'addTransaction',
    transaction: {
      timestamp,
      type,
      amount: {
        currencyCode: currency,
        centAmount: amount,
      },
      state,
      interactionId,
    },
  }
}

function getSetMethodInfoMethodAction(paymentMethod) {
  return {
    action: 'setMethodInfoMethod',
    method: paymentMethod,
  }
}

function getSetMethodInfoNameAction(paymentMethod) {
  const paymentMethodsToLocalizedNames = config.getAdyenPaymentMethodsToNames()
  const paymentMethodLocalizedNames =
    paymentMethodsToLocalizedNames[paymentMethod]
  if (paymentMethodLocalizedNames)
    return {
      action: 'setMethodInfoName',
      name: paymentMethodLocalizedNames,
    }
  return null
}

async function getPaymentByMerchantReference(
  merchantReference,
  pspReference,
  ctpClient,
) {
  try {
    const keys = [merchantReference, pspReference]
    const result = await ctpClient.fetchByKeys(ctpClient.builder.payments, keys)
    return result.body?.results[0]
  } catch (err) {
    if (err.statusCode === 404) return null
    const errMsg =
      `Failed to fetch a payment with merchantReference ${merchantReference} and pspReference ${pspReference}. ` +
      `Error: ${JSON.stringify(serializeError(err))}`
    throw new VError(err, errMsg)
  }
}

export default { processNotification }
