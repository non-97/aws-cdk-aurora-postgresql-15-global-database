import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export interface AuroraProps {
  vpc: cdk.aws_ec2.IVpc;
  dbClusterSg: cdk.aws_ec2.ISecurityGroup;
  isPrimaryDbCluster: boolean;
  globalClusterIdentifier: string;
}

export class Aurora extends Construct {
  constructor(scope: Construct, id: string, props: AuroraProps) {
    super(scope, id);

    // DB Cluster Parameter Group
    const dbClusterParameterGroup = new cdk.aws_rds.ParameterGroup(
      this,
      "DbClusterParameterGroup",
      {
        engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
          version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_15_2,
        }),
        description: "aurora-postgresql15",
        parameters: {
          log_statement: "none",
          "pgaudit.log": "all",
          "pgaudit.role": "rds_pgaudit",
          shared_preload_libraries: "pgaudit",
          ssl_ciphers: "TLS_RSA_WITH_AES_256_GCM_SHA384",
        },
      }
    );

    // DB Parameter Group
    const dbParameterGroup = new cdk.aws_rds.ParameterGroup(
      this,
      "DbParameterGroup",
      {
        engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
          version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_15_2,
        }),
        description: "aurora-postgresql15",
      }
    );

    // Subnet Group
    const subnetGroup = new cdk.aws_rds.SubnetGroup(this, "SubnetGroup", {
      description: "description",
      vpc: props.vpc,
      subnetGroupName: "SubnetGroup",
      vpcSubnets: props.vpc.selectSubnets({
        onePerAz: true,
        subnetType: cdk.aws_ec2.SubnetType.PRIVATE_ISOLATED,
      }),
    });

    // Monitoring Role
    const monitoringRole = new cdk.aws_iam.Role(this, "MonitoringRole", {
      assumedBy: new cdk.aws_iam.ServicePrincipal(
        "monitoring.rds.amazonaws.com"
      ),
      managedPolicies: [
        cdk.aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AmazonRDSEnhancedMonitoringRole"
        ),
      ],
    });

    // DB Cluster
    const dbCluster = new cdk.aws_rds.DatabaseCluster(this, "Default", {
      engine: cdk.aws_rds.DatabaseClusterEngine.auroraPostgres({
        version: cdk.aws_rds.AuroraPostgresEngineVersion.VER_15_2,
      }),
      writer: cdk.aws_rds.ClusterInstance.serverlessV2("Instance", {
        allowMajorVersionUpgrade: false,
        autoMinorVersionUpgrade: true,
        enablePerformanceInsights: true,
        parameterGroup: dbParameterGroup,
        performanceInsightRetention:
          cdk.aws_rds.PerformanceInsightRetention.DEFAULT,
        publiclyAccessible: false,
        instanceIdentifier: props.isPrimaryDbCluster
          ? "db-instance"
          : "db-instance-secondary",
      }),
      serverlessV2MaxCapacity: 1.0,
      serverlessV2MinCapacity: 0.5,
      backup: {
        retention: cdk.Duration.days(7),
        preferredWindow: "16:00-16:30",
      },
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: cdk.aws_logs.RetentionDays.ONE_YEAR,
      clusterIdentifier: props.isPrimaryDbCluster
        ? "db-cluster"
        : "db-cluster-secondary",
      copyTagsToSnapshot: true,
      defaultDatabaseName: "testDB",
      deletionProtection: false,
      iamAuthentication: false,
      monitoringInterval: cdk.Duration.minutes(1),
      monitoringRole,
      parameterGroup: dbClusterParameterGroup,
      preferredMaintenanceWindow: "Sat:17:00-Sat:17:30",
      storageEncrypted: true,
      storageEncryptionKey: cdk.aws_kms.Alias.fromAliasName(
        this,
        "DefaultRdsKey",
        "alias/aws/rds"
      ),
      vpc: props.vpc,
      securityGroups: [props.dbClusterSg],
      subnetGroup,
    });

    // CA
    dbCluster.node.children.forEach((children) => {
      if (children.node.defaultChild instanceof cdk.aws_rds.CfnDBInstance) {
        (
          children.node.defaultChild as cdk.aws_rds.CfnDBInstance
        ).addPropertyOverride("CACertificateIdentifier", "rds-ca-rsa4096-g1");
      }
    });

    // Global Database
    if (props.isPrimaryDbCluster) {
      new cdk.aws_rds.CfnGlobalCluster(scope, "GlobalDatabase", {
        deletionProtection: false,
        globalClusterIdentifier: props.globalClusterIdentifier,
        sourceDbClusterIdentifier: dbCluster.clusterIdentifier,
      });
    } else {
      const cfnDbCluster = dbCluster.node
        .defaultChild as cdk.aws_rds.CfnDBCluster;

      cfnDbCluster.globalClusterIdentifier = props.globalClusterIdentifier;
      cfnDbCluster.databaseName = undefined;
      cfnDbCluster.addPropertyDeletionOverride("MasterUsername");
      cfnDbCluster.addPropertyDeletionOverride("MasterUserPassword");
      dbCluster.node.tryRemoveChild("Secret");
    }
  }
}
